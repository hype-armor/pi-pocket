/** Best-effort activity for fresh webhook roots. Capabilities, sequences, and leases exist in this process only. */
import { createHmac } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type LiveState, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Hook, HooksDoc } from "./docs.ts";
import { createPublicFetch } from "./public-fetch.ts";
import { replyUrlProblem } from "./reply-hooks.ts";

const context = BACKGROUND_CONTEXT;

export const ACTIVITY_LEASE_MS = 8_000;
export const ACTIVITY_REFRESH_MS = 3_000;
export const ACTIVITY_TIMEOUT_MS = 1_000;
const POLL_MS = 250;
const MAX_ROOTS = 1_000;

export const ACTIVITY_BATCH_SIZE = 32;
export const ACTIVITY_MAX_SENDS = 8;
const MAX_SEQUENCE = 2_147_483_647;
const WAIT_TOOLS = new Set(["ask", "ask_someone", "team", "subagent", "resource_queue_start"]);

type Detail = { state: "thinking" | "working" } | { state: "using"; tool: string };
export type ActivityPayload = {
    protocol: 1;
    hook: string;
    request: string;
    sequence: number;
    expiresAt: number;
    state: Detail["state"] | "stopped";
    tool?: string;
    token: string;
};

type Root = {
    hook: string;
    key: string;
    request: string;
    submissionRequest: string;
    target: ConversationId;
    token: string;
    url: string;
    secret: string;
    sequence: number;
    sentAt: number;
    detail?: string;
    busy: boolean;
    active: boolean;
    sentOrder: number;
};

/** Activity signatures cannot authenticate a reply, or the reverse. Times use Unix milliseconds. */
export function signActivity(secret: string, timestamp: number, body: string): string {
    return `sha256=${createHmac("sha256", secret)
        .update(`activity-v1.${timestamp}.${body}`)
        .digest("hex")}`;
}

/** An activity capability never selects an arbitrary callback path. */
export function activityUrl(reply: string): string | undefined {
    if (replyUrlProblem(reply) !== undefined) {
        return undefined;
    }

    const url = new URL(reply);

    if (url.pathname !== "/v1/reply") {
        return undefined;
    }

    url.pathname = "/v1/activity";

    return url.toString();
}

/** Inspect block kinds and running tool names only. Never read thinking text, arguments, or outputs. */
export function activityDetail(live: LiveState, waiting = false): Detail {
    if (
        waiting ||
        live.generation?.retry !== undefined ||
        live.generation?.deferred !== undefined ||
        (live.compactions?.length ?? 0) > 0
    ) {
        return { state: "working" };
    }

    const running = [...(live.tools ?? []), ...(live.nestedTools ?? [])].filter(
        (tool) => tool.status === "running",
    );

    if (running.length > 0) {
        const name = running[0]!.name;

        return running.length === 1 &&
            !WAIT_TOOLS.has(name) &&
            /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)
            ? { state: "using", tool: name }
            : { state: "working" };
    }

    // A tool round or a pending tool is not a model thought from the preceding response.
    if ((live.tools?.length ?? 0) > 0 || (live.nestedTools?.length ?? 0) > 0) {
        return { state: "working" };
    }

    const blocks = live.generation?.message?.content;

    return Array.isArray(blocks) && blocks.at(-1)?.type === "thinking"
        ? { state: "thinking" }
        : { state: "working" };
}

export class ActivityDelivery {
    readonly #app: PocketApp;
    readonly #roots = new Map<string, Root>();
    readonly #fetchPublic = createPublicFetch();
    readonly #abort = new AbortController();
    #probing = false;
    #sending = 0;
    #sentOrder = 0;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    start(): () => void {
        const timer = setInterval(() => void this.sweep(), POLL_MS);

        timer.unref();

        return () => {
            clearInterval(timer);
            this.#roots.clear();
            this.#abort.abort();
        };
    }

    /** Called only after authenticated admission creates a fresh original receipt, before its submission. */
    enroll(
        hook: Hook,
        key: string,
        submissionRequest: string,
        token: string,
    ): (() => void) | undefined {
        const url = hook.reply === undefined ? undefined : activityUrl(hook.reply.url);
        const id = `${hook.id}\0${key}`;

        if (
            url === undefined ||
            !/^[0-9a-f]{64}$/.test(token) ||
            this.#abort.signal.aborted ||
            this.#roots.has(id) ||
            this.#roots.size >= MAX_ROOTS
        ) {
            return;
        }

        const receipt = hook.reply?.requests?.[key];

        if (receipt === undefined || receipt.done || receipt.root !== undefined) {
            return;
        }

        const root: Root = {
            hook: hook.id,
            key,
            request: receipt.request,
            submissionRequest,
            target: hook.target as unknown as ConversationId,
            token,
            url,
            secret: hook.reply!.secret,
            sequence: 0,
            sentAt: 0,
            busy: false,
            active: false,
            sentOrder: 0,
        };

        this.#roots.set(id, root);

        // Only the invocation that enrolled this root receives its refusal handle.
        return () => void this.#refused(id, root);
    }

    /** A refused invocation cannot stop an admitted submission, including one admitted by a concurrent duplicate. */
    async #refused(id: string, root: Root): Promise<void> {
        try {
            const admitted = await this.#app.harness.commit(
                (tx) => tx.submissionByRequest(root.target, root.submissionRequest),
                context,
            );

            if (admitted === undefined && this.#roots.get(id) === root) {
                this.#roots.delete(id);
                await this.#send(root, { state: "stopped" });
            }
        } catch {
            // An uncertain admission cannot authorize a terminal stop. Its lease can expire instead.
        }
    }

    /** At most one bounded probe can occupy the mutation line. A stalled probe never queues more probes. */
    async sweep(): Promise<void> {
        if (this.#probing || this.#abort.signal.aborted) {
            return;
        }

        const batch: [string, Root][] = [];
        const slots = ACTIVITY_MAX_SENDS - this.#sending;
        const candidates =
            slots <= 0
                ? []
                : [...this.#roots.entries()]
                      .filter(([, root]) => root.active && !root.busy)
                      .sort((left, right) => left[1].sentOrder - right[1].sentOrder)
                      .slice(0, slots);

        // A free send slot chooses from all active roots, independent of the probe batch phase.
        // Only scheduling metadata stays in memory; each candidate gets a fresh durable probe.
        for (const entry of candidates) {
            entry[1].busy = true;
            batch.push(entry);
        }

        for (const entry of this.#roots) {
            if (!entry[1].busy) {
                entry[1].busy = true;
                batch.push(entry);
            }

            if (batch.length >= ACTIVITY_BATCH_SIZE) {
                break;
            }
        }

        if (batch.length === 0) {
            return;
        }

        // Rotate stable root identities, not indexes in a changing filtered list.
        for (const [id, root] of batch) {
            this.#roots.delete(id);
            this.#roots.set(id, root);
        }

        this.#probing = true;
        let released = false;

        try {
            const samples = await this.#app.harness.commit(async (tx) => {
                const hooks = (await tx.doc(HooksDoc)).items;
                const live = new Map<ConversationId, LiveState>();
                const samples: (Detail | { state: "stopped" } | undefined)[] = [];

                for (const [, root] of batch) {
                    samples.push(await this.#read(tx, hooks[root.hook], root, live));
                }

                return samples;
            }, context);

            // Network waits cannot hold the probe slot or the mutation line.
            this.#probing = false;
            released = true;
            const ready = batch.map(([id, root], index) => ({ id, root, sample: samples[index] }));

            // Under transport saturation, give unsent and oldest leases the next available send slots.
            ready.sort((left, right) => left.root.sentOrder - right.root.sentOrder);
            await Promise.all(ready.map(({ id, root, sample }) => this.#apply(id, root, sample)));
        } catch {
            // Best effort only. No payloads, capabilities, provider errors, or retry outbox in logs.
        } finally {
            if (!released) {
                this.#probing = false;
            }

            for (const [, root] of batch) {
                root.busy = false;
            }
        }
    }

    async #read(
        tx: Tx,
        hook: Hook | undefined,
        root: Root,
        cache: Map<ConversationId, LiveState>,
    ): Promise<Detail | { state: "stopped" } | undefined> {
        const app = this.#app;
        const receipt = hook?.reply?.requests?.[root.key];
        const person = hook === undefined ? undefined : app.config.userById(hook.by);

        if (
            hook?.target !== Number(root.target) ||
            hook.reply?.secret !== root.secret ||
            activityUrl(hook.reply.url) !== root.url ||
            receipt?.submissionRequest !== root.submissionRequest ||
            receipt.request !== root.request ||
            receipt.root !== undefined ||
            receipt.done ||
            receipt.pending !== undefined ||
            person?.role !== "owner" ||
            !app.canSee(person, root.target) ||
            !app.hooks.running
        ) {
            return { state: "stopped" };
        }

        const submission = await tx.submissionByRequest(root.target, root.submissionRequest);

        if (submission === undefined || submission.status === "queued") {
            return undefined;
        }

        if (submission.type !== "input" || submission.status !== "placed") {
            return { state: "stopped" };
        }

        let live = cache.get(root.target);

        if (live === undefined) {
            live = await tx.doc(LiveDoc, root.target);
            cache.set(root.target, live);
        }

        if (live.run === undefined || !live.run.inputs.includes(submission.id)) {
            return undefined;
        }

        return activityDetail(
            live,
            app.approvals.forConversation(root.target).length > 0 ||
                app.limits.waitFor(Number(root.target)) !== undefined,
        );
    }

    async #apply(
        id: string,
        root: Root,
        sample: Detail | { state: "stopped" } | undefined,
    ): Promise<void> {
        if (this.#roots.get(id) !== root || this.#abort.signal.aborted) {
            return;
        }

        root.active = sample !== undefined && sample.state !== "stopped";

        if (sample === undefined) {
            return;
        }

        const detail = JSON.stringify(sample);

        if (sample.state === "stopped" || root.sequence >= MAX_SEQUENCE - 1) {
            this.#roots.delete(id);
            await this.#send(root, { state: "stopped" });
        } else if (root.detail !== detail || Date.now() - root.sentAt >= ACTIVITY_REFRESH_MS) {
            await this.#send(root, sample);
        }
    }

    async #send(root: Root, detail: Detail | { state: "stopped" }): Promise<void> {
        if (this.#sending >= ACTIVITY_MAX_SENDS || this.#abort.signal.aborted) {
            return;
        }

        this.#sending += 1;
        // A dropped sample must not replace the last attempted detail or consume its sequence.
        root.detail = JSON.stringify(detail);
        root.sentOrder = ++this.#sentOrder;
        const timestamp = Date.now();
        const payload: ActivityPayload = {
            protocol: 1,
            hook: root.hook,
            request: root.request,
            sequence: ++root.sequence,
            expiresAt: timestamp + ACTIVITY_LEASE_MS,
            ...detail,
            token: root.token,
        };
        const body = JSON.stringify(payload);

        root.sentAt = timestamp;

        try {
            const url = new URL(root.url);
            const local =
                url.protocol === "http:" &&
                ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);

            if (local && url.hostname === "localhost") {
                url.hostname = "127.0.0.1";
            }

            const send = local ? fetch : this.#fetchPublic;
            const response = await send(url, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.any([
                    this.#abort.signal,
                    AbortSignal.timeout(ACTIVITY_TIMEOUT_MS),
                ]),
                headers: {
                    "content-type": "application/json",
                    "x-pocket-hook": root.hook,
                    "x-pocket-timestamp": String(timestamp),
                    "x-pocket-signature": signActivity(root.secret, timestamp, body),
                },
                body,
            });

            await response.body?.cancel();
        } catch {
            // The receiver falls back when the short lease expires. Never retry or touch final replies.
        } finally {
            this.#sending -= 1;
        }
    }
}
