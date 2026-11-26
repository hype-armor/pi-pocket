/**
 * Deliver signed replies for exact durable submissions. Root receipts exist before admission. Derived receipts exist
 * before a background or subagent notification enters the conversation. Sweeps read only their named submission.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    type Hook,
    HooksDoc,
    ReplyMediaManifestsDoc,
    type ReplyOrigin,
    type ReplyOrigins,
} from "./docs.ts";
import { projectEntry } from "./projection.ts";
import { createPublicFetch } from "./public-fetch.ts";
import { replyBody, signReply } from "./reply-hooks.ts";
import {
    descriptor,
    descriptors,
    hashFile,
    readPinnedMedia,
    type MediaDescriptor,
} from "./reply-media.ts";
import { readWorkspaceExport } from "./reply-media-export.ts";

const context = BACKGROUND_CONTEXT;

export const SWEEP_MS = 1_000;
export const MAX_ATTEMPTS = 10;
export const MAX_BACKOFF_MS = 10 * 60_000;
export const SEND_TIMEOUT_MS = 10_000;

type Receipt = NonNullable<NonNullable<Hook["reply"]>["requests"]>[string];
type Pending = NonNullable<Receipt["pending"]>;
type OwnedTool = {
    id: TaskId;
    conversationId: ConversationId;
    kind: string;
    owner?: TaskId;
    abortRequested: boolean;
    state: { status: string };
};

/** Codemode children must reach this exact live model run through tool tasks only. */
async function toolOwnedBy(
    tx: Pick<Tx, "task">,
    initial: OwnedTool,
    conversation: ConversationId,
    run: TaskId,
): Promise<boolean> {
    let current: OwnedTool | undefined = initial;
    const seen = new Set<string>();

    for (let depth = 0; current !== undefined && depth < 32; depth++) {
        if (
            current.conversationId !== conversation ||
            current.kind !== "pi.tool" ||
            current.abortRequested ||
            current.state.status !== "running" ||
            seen.has(String(current.id))
        ) {
            return false;
        }

        seen.add(String(current.id));

        if (current.owner === run) {
            return true;
        }

        current = current.owner === undefined ? undefined : await tx.task(current.owner);
    }

    return false;
}

/** Receivers cannot make a retry allocate an unbounded response body. */
async function boundedAnswer(
    response: Response,
): Promise<{ accepted?: unknown; active?: unknown } | undefined> {
    const reader = response.body?.getReader();

    if (reader === undefined) {
        return undefined;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        for (;;) {
            const next = await reader.read();

            if (next.done) {
                break;
            }

            total += next.value.length;

            if (total > 65_536) {
                throw new Error("Reply acknowledgement exceeds its bound.");
            }

            chunks.push(next.value);
        }

        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));

        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? value
            : undefined;
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

/** The durable result of reserving all derived receipts for one source submission. */
export type ReplyReservation = "reserved" | "suppressed" | "capacity";

export function backoffMs(attempts: number): number {
    return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(attempts, 20));
}

/** A safe object key for one source submission under one root receipt. */
function derivedKey(origin: ReplyOrigin, request: string): string {
    return `reply-${createHash("sha256")
        .update(`${origin.key}\0${request}`)
        .digest("base64url")
        .slice(0, 32)}`;
}

/** The root origin of a receipt with the authenticated follow-up capability. */
function originOf(hook: Hook, key: string, receipt: Receipt): ReplyOrigin | undefined {
    if (receipt.followUp !== true) {
        return undefined;
    }

    return {
        hookId: hook.id,
        key: receipt.root ?? key,
        request: receipt.request,
        followUp: true,
        ...(receipt.protocol === 3 ? { protocol: 3 as const } : {}),
    };
}

function originKey(origin: ReplyOrigin): string {
    return `${origin.hookId}\0${origin.key}\0${origin.request}`;
}

/** Drop duplicate roots and give every durable root set one stable order. */
function canonicalOrigins(origins: readonly ReplyOrigin[]): ReplyOrigins {
    return [...new Map(origins.map((origin) => [originKey(origin), origin])).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, origin]) => origin);
}

export class ReplyDelivery {
    readonly #app: PocketApp;
    readonly #fetchPublic = createPublicFetch();
    #busy = false;
    readonly #controlsInFlight = new Set<string>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    start(): () => void {
        const stop = this.#app.events.on("run.ended", () => this.#wake());
        const timer = setInterval(() => this.#wake(), SWEEP_MS);

        timer.unref();
        this.#wake();

        return () => {
            stop();
            clearInterval(timer);
        };
    }

    /**
     * Find trusted hook roots while a model tool call runs. Every input must name one or more eligible roots.
     * A mixed run or an unrooted owner input is deliberately not attributable.
     */
    async originForTool(
        conversationId: ConversationId,
        taskId: TaskId,
    ): Promise<ReplyOrigins | undefined> {
        const [live, tool, hooks] = await Promise.all([
            this.#app.harness.snapshot(LiveDoc, conversationId, context),
            this.#app.harness.commit((tx) => tx.task(taskId), context),
            this.#app.harness.snapshot(HooksDoc, context),
        ]);

        if (
            live?.run === undefined ||
            tool?.conversationId !== conversationId ||
            tool.kind !== "pi.tool" ||
            tool.owner === undefined ||
            tool.abortRequested ||
            tool.state.status !== "running"
        ) {
            return undefined;
        }

        if (
            !(await this.#app.harness.commit(
                (tx) => toolOwnedBy(tx, tool, conversationId, live.run!.taskId),
                context,
            ))
        ) {
            return undefined;
        }

        const records = await Promise.all(
            live.run.inputs.map(async (id) => {
                const submission = await this.#app.harness.submission(id, context);

                return submission?.status(context);
            }),
        );
        const all = Object.values(hooks?.items ?? {});
        const found: ReplyOrigin[] = [];

        for (const record of records) {
            if (record?.type !== "input" || record.requestId === undefined) {
                return undefined;
            }

            const matches = all.flatMap((hook) =>
                hook.target !== Number(conversationId)
                    ? []
                    : Object.entries(hook.reply?.requests ?? {})
                          .filter(([, receipt]) => receipt.submissionRequest === record.requestId)
                          .map(([key, receipt]) => originOf(hook, key, receipt))
                          .filter((origin): origin is ReplyOrigin => origin !== undefined),
            );

            if (matches.length === 0) {
                return undefined;
            }

            found.push(...matches);
        }

        const roots = canonicalOrigins(found);

        return roots.length === 0 ? undefined : roots;
    }

    /**
     * Copy one already guard-approved workspace export before human approval. The copy is private and hash-pinned, but
     * this method sends nothing. The caller must request an owner-only approval before any later delivery.
     */
    async prepareMedia(
        conversationId: ConversationId,
        taskId: TaskId,
        callId: string,
        source: string,
        mime: string,
    ): Promise<{ file: MediaDescriptor; path: string }> {
        // Keep every directory descriptor open. `/proc/self/fd/<fd>/name` resolves below that already-open
        // directory, so a hostile rename or ancestor symlink swap cannot redirect the walk.
        if (basename(source) !== source || source === "." || source === "..") {
            throw new Error("Reply media exports must use one flat file name.");
        }

        const origins = await this.originForTool(conversationId, taskId);

        if (origins?.length !== 1 || origins[0]!.protocol !== 3) {
            throw new Error("Reply file export requires one live protocol-3 input root.");
        }

        const scope = await this.#app.harness.commit(
            async (tx) =>
                (await tx.task(taskId))?.memos?.["pocket.reply-media.guard"] as
                    { cwd?: string; name?: string } | undefined,
            context,
        );
        const cwd = scope?.cwd;

        if (
            typeof cwd !== "string" ||
            scope?.name !== source ||
            !isAbsolute(cwd) ||
            resolve(cwd).split(sep).length > 128
        ) {
            throw new Error("Reply file export requires an exact guard-approved local Linux path.");
        }

        try {
            const bytes = await readWorkspaceExport(cwd, String(conversationId), source);
            const sha256 = hashFile(bytes);
            const id = createHash("sha256")
                .update(JSON.stringify([String(conversationId), String(taskId), callId, sha256]))
                .digest("hex");
            const file = descriptor({ id, name: source, mime, size: bytes.length, sha256 });
            const directory = join(
                this.#app.workspace.uploadDirectory(conversationId),
                "reply-media",
            );

            await mkdir(directory, { recursive: true, mode: 0o700 });
            const path = join(directory, sha256);

            try {
                await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }
            }

            // This private copy is only prepared. The owner-only approval and `registerMedia()` come later.
            return { file, path };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(
                    `Create the export file at ${join(cwd, ".pi-chat-exports", String(conversationId), source)} first. Then call share_reply_file with only its basename.`,
                );
            }

            throw error;
        }
    }

    /** Save and synchronously deliver one monotonic protocol-3 approval control for the exact live tool root. */
    async approvalControl(
        conversationId: ConversationId,
        taskId: TaskId,
        file: MediaDescriptor,
        status: "awaiting-file-approval" | "file-approval-resolved",
    ): Promise<void> {
        const origins = await this.originForTool(conversationId, taskId);

        if (origins === undefined || origins.length !== 1 || origins[0]!.protocol !== 3) {
            throw new Error("This tool call has no unambiguous protocol-3 reply root.");
        }

        const origin = origins[0]!;

        await this.#app.harness.commit(async (tx) => {
            const hooks = await tx.doc(HooksDoc);
            const current = hooks.items[origin.hookId];
            const receipt = current?.reply?.requests?.[origin.key];

            if (receipt?.request !== origin.request || receipt.protocol !== 3) {
                throw new Error("The protocol-3 reply root is no longer authorized.");
            }

            receipt.controls ??= {};
            // Stored draft builds used strings. Keep their monotonic meaning, but require this fresh call to provide
            // the descriptor before any callback can leave the process.
            const raw = receipt.controls[file.id] as unknown;
            const prior = typeof raw === "string" ? { status: raw } : raw;

            if (
                prior !== undefined &&
                typeof prior === "object" &&
                (prior as { status?: unknown }).status === "file-approval-resolved" &&
                status === "awaiting-file-approval"
            ) {
                throw new Error("A resolved file approval cannot become pending again.");
            }

            const existing = prior as
                | { file?: MediaDescriptor; status?: string; acknowledged?: true; inactive?: true }
                | undefined;

            if (
                existing?.file !== undefined &&
                JSON.stringify(existing.file) !== JSON.stringify(file)
            ) {
                throw new Error("A file approval id cannot change its descriptor.");
            }

            if (existing?.file !== undefined && existing.status === status) {
                return;
            }

            if (
                status === "file-approval-resolved" &&
                (existing?.status !== "awaiting-file-approval" ||
                    existing.acknowledged !== true ||
                    existing.inactive)
            ) {
                throw new Error("The pending file approval has no durable active acknowledgement.");
            }

            if (existing === undefined && Object.keys(receipt.controls).length >= 16) {
                throw new Error("This reply root has reached its file approval limit.");
            }

            receipt.controls[file.id] = { file, status, attempts: 0, nextAt: 0 };
        }, context);

        for (;;) {
            if (
                (await this.originForTool(conversationId, taskId))?.some(
                    (candidate) => originKey(candidate) === originKey(origin),
                ) !== true
            ) {
                throw new Error("The file tool no longer has a live reply root.");
            }

            const liveHook = (await this.#app.harness.snapshot(HooksDoc, context))?.items[
                origin.hookId
            ];

            if (liveHook === undefined || !this.#authorized(liveHook)) {
                throw new Error("The reply hook is no longer authorized.");
            }

            await this.#sendControl(liveHook, origin.key, origin.request, file, status).catch(
                () => undefined,
            );
            const latest = (await this.#app.harness.snapshot(HooksDoc, context))?.items[
                origin.hookId
            ]?.reply?.requests?.[origin.key]?.controls?.[file.id];

            if (latest === undefined || latest.status !== status || latest.inactive) {
                throw new Error("The original reply route is no longer active.");
            }

            if (latest.acknowledged) {
                return;
            }

            await new Promise((resolve) =>
                setTimeout(resolve, Math.max(10, Math.min(1000, latest.nextAt - Date.now()))),
            );
        }
    }

    #authorized(hook: Hook): boolean {
        const person = this.#app.config.userById(hook.by);

        return (
            this.#app.hooks.running &&
            person?.role === "owner" &&
            this.#app.canSee(person, hook.target as unknown as ConversationId)
        );
    }

    async #sendControl(
        hook: Hook,
        key: string,
        request: string,
        file: MediaDescriptor,
        status: "awaiting-file-approval" | "file-approval-resolved",
    ): Promise<void> {
        const id = `${hook.id}\0${key}\0${file.id}`;

        if (this.#controlsInFlight.has(id) || !this.#authorized(hook)) {
            return;
        }

        this.#controlsInFlight.add(id);

        try {
            await this.#attemptControl(hook, key, request, file, status);
        } finally {
            this.#controlsInFlight.delete(id);
        }
    }

    /** Persist one control attempt before the HTTP effect, then persist its ACK, backoff, or inactive route. */
    async #attemptControl(
        hook: Hook,
        key: string,
        request: string,
        file: MediaDescriptor,
        status: "awaiting-file-approval" | "file-approval-resolved",
    ): Promise<void> {
        let current: Hook | undefined;

        await this.#app.harness.commit(async (tx) => {
            const hooks = await tx.doc(HooksDoc);
            const receipt = hooks.items[hook.id]?.reply?.requests?.[key];
            const control = receipt?.controls?.[file.id];

            if (
                control === undefined ||
                control.status !== status ||
                control.acknowledged ||
                control.inactive ||
                control.nextAt > Date.now()
            ) {
                return;
            }

            control.attempts += 1;
            control.nextAt = Date.now() + backoffMs(control.attempts);
            current = JSON.parse(JSON.stringify(hooks.items[hook.id])) as Hook;
        }, context);

        if (current?.reply === undefined) {
            return;
        }

        const body = JSON.stringify({
            hook: current.id,
            request,
            protocol: 3,
            status,
            approval: file.id,
        });
        const timestamp = Date.now();
        const url = new URL(current.reply!.url);
        const local =
            url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);

        if (local && url.hostname === "localhost") {
            url.hostname = "127.0.0.1";
        }

        const send = local ? fetch : this.#fetchPublic;
        const response = await send(url, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            headers: {
                "content-type": "application/json",
                "x-pocket-hook": current.id,
                "x-pocket-timestamp": String(timestamp),
                "x-pocket-signature": signReply(current.reply!.secret, timestamp, body),
            },
            body,
        });
        const answer = await boundedAnswer(response).catch(() => undefined);

        const inactive =
            (response.ok && answer?.accepted === true && answer.active === false) ||
            [401, 403, 404, 409, 410].includes(response.status);

        await this.#app.harness.commit(async (tx) => {
            const receipt = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key];
            const control = receipt?.controls?.[file.id];

            if (control === undefined || control.status !== status) {
                return;
            }

            if (response.ok && answer?.accepted === true && answer.active === true) {
                control.acknowledged = true;
                control.nextAt = 0;
            }

            if (inactive) {
                control.inactive = true;
            }
        }, context);

        if (!response.ok || answer?.accepted !== true || (answer.active !== true && !inactive)) {
            throw new Error("The reply bridge did not accept the file approval control.");
        }

        if (inactive) {
            throw new Error("The original reply route is no longer active.");
        }
    }

    /**
     * Register an immutable private copy for one exact protocol-3 tool call. This derives its root from the live task,
     * never from a session answer, a hook selected by the caller, or the current requester.
     */
    async registerMedia(
        conversationId: ConversationId,
        taskId: TaskId,
        callId: string,
        rawFile: unknown,
        path: string,
    ): Promise<void> {
        const origins = await this.originForTool(conversationId, taskId);

        if (origins === undefined || origins.length !== 1 || origins[0]!.protocol !== 3) {
            throw new Error("This tool call has no unambiguous protocol-3 reply root.");
        }

        const file = descriptor(rawFile);
        const directory = resolve(
            this.#app.workspace.uploadDirectory(conversationId),
            "reply-media",
        );
        const target = resolve(path);

        if (!target.startsWith(directory + sep)) {
            throw new Error("Reply media must be an immutable private upload copy.");
        }

        await readPinnedMedia(target, file, directory);

        const origin = origins[0]!;
        const key = `${String(taskId)}:${callId}`;

        await this.#app.harness.commit(async (tx) => {
            const hooks = (await tx.doc(HooksDoc)).items;
            const receipt = hooks[origin.hookId]?.reply?.requests?.[origin.key];

            if (
                receipt?.request !== origin.request ||
                receipt.followUp !== true ||
                receipt.protocol !== 3
            ) {
                throw new Error("The protocol-3 reply root is no longer authorized.");
            }

            const tool = await tx.task(taskId);
            const approval = tool?.memos?.["pocket.reply-media.approval"] as
                { allow?: boolean; ownerId?: string } | undefined;
            const control = receipt.controls?.[file.id];
            const prepared = tool?.memos?.["pocket.reply-media.prepared"] as
                { file?: MediaDescriptor; path?: string } | undefined;

            if (
                prepared === undefined ||
                prepared.path !== target ||
                JSON.stringify(prepared.file) !== JSON.stringify(file)
            ) {
                throw new Error("Reply media differs from its owner-approved prepared copy.");
            }

            if (
                tool?.owner === undefined ||
                tool.kind !== "pi.tool" ||
                tool.abortRequested ||
                approval?.allow !== true ||
                this.#app.config.userById(approval.ownerId ?? "")?.role !== "owner" ||
                control?.status !== "file-approval-resolved" ||
                control.acknowledged !== true ||
                control.inactive
            ) {
                throw new Error(
                    "Reply media has no exact owner approval and resolved control acknowledgement.",
                );
            }

            const live = await tx.doc(LiveDoc, conversationId);

            if (
                live.run === undefined ||
                !(await toolOwnedBy(tx, tool, conversationId, live.run.taskId))
            ) {
                throw new Error("Reply media no longer belongs to the exact live model run.");
            }

            const submissions: string[] = [];

            for (const input of live.run.inputs) {
                const submitted = await tx.submission(input);

                if (submitted?.type !== "input" || submitted.requestId === undefined) {
                    throw new Error("Reply media has an unrooted active input.");
                }

                submissions.push(submitted.requestId);
            }

            submissions.sort();
            const manifests = await tx.doc(ReplyMediaManifestsDoc, conversationId);
            const related = Object.values(manifests.items).filter(
                (item) =>
                    item.hookId === origin.hookId &&
                    item.root === origin.key &&
                    item.request === origin.request &&
                    item.entry === undefined &&
                    item.submissions.some((request) => submissions.includes(request)),
            );

            if (
                !related.some((item) => item.file.id === file.id) &&
                (related.length >= 4 ||
                    related.reduce((total, item) => total + item.file.size, 0) + file.size >
                        40 * 1024 * 1024)
            ) {
                throw new Error("A reply route can share at most 4 files and 40 MiB.");
            }

            const next = {
                hookId: origin.hookId,
                root: origin.key,
                request: origin.request,
                conversation: String(conversationId),
                task: String(taskId),
                modelTask: String(live.run.taskId),
                submissions,
                call: callId,
                file,
                path: target,
            };
            const prior = manifests.items[key];

            if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(next)) {
                throw new Error("This tool call already registered different reply media.");
            }

            manifests.items[key] ??= next;
        }, context);
    }

    /**
     * Save one derived receipt before its notification submission. Its deterministic key makes a retry retain the
     * original bridge request, source request, and sequence.
     */
    async reserve(
        conversationId: ConversationId,
        submissionRequest: string,
        origins: ReplyOrigins | undefined,
    ): Promise<ReplyReservation> {
        const roots = canonicalOrigins(origins ?? []);

        if (roots.length === 0) {
            return "suppressed";
        }

        return this.#app.harness.commit(async (tx) => {
            const items = (await tx.doc(HooksDoc)).items;
            const planned = new Map<string, number>();

            // Check every root before writing any receipt. One full or removed hook leaves this source unreserved.
            for (const origin of roots) {
                const hook = items[origin.hookId];

                if (hook?.target !== Number(conversationId) || hook.reply === undefined) {
                    return "suppressed";
                }

                const receipts = hook.reply.requests ?? {};
                const key = derivedKey(origin, submissionRequest);

                if (receipts[key] !== undefined) {
                    continue;
                }

                const active = Object.values(receipts).filter((receipt) => !receipt.done).length;
                const count = planned.get(origin.hookId) ?? 0;

                if (active + count >= 1000) {
                    return "capacity";
                }

                planned.set(origin.hookId, count + 1);
            }

            for (const origin of roots) {
                const hook = items[origin.hookId]!;
                const receipts = (hook.reply!.requests ??= {});
                const key = derivedKey(origin, submissionRequest);

                if (receipts[key] !== undefined) {
                    continue;
                }

                if (Object.keys(receipts).length >= 1000) {
                    for (const [oldKey, receipt] of Object.entries(receipts)) {
                        if (receipt.done) {
                            delete receipts[oldKey];
                        }
                    }
                }

                const sequence =
                    Math.max(
                        0,
                        ...Object.values(receipts)
                            .filter((receipt) => receipt.request === origin.request)
                            .map((receipt) => receipt.sequence ?? 0),
                    ) + 1;

                receipts[key] = {
                    request: origin.request,
                    submissionRequest,
                    root: origin.key,
                    followUp: true,
                    ...(origin.protocol === 3 && receipts[origin.key]?.protocol === 3
                        ? { protocol: 3 as const }
                        : {}),
                    sequence,
                };
            }

            return "reserved";
        }, context);
    }

    #wake(): void {
        void this.sweep().catch((error: unknown) => {
            this.#app.log(
                `reply hook: ${error instanceof Error ? error.constructor.name : "error"} during delivery`,
            );
        });
    }

    /** Recover exact completed submissions, then send due replies. Only one sweep can run. */
    async sweep(): Promise<void> {
        if (this.#busy) {
            return;
        }

        this.#busy = true;

        try {
            const hooks = Object.values(
                (await this.#app.harness.snapshot(HooksDoc, context))?.items ?? {},
            );

            for (const hook of hooks) {
                for (const [key, receipt] of Object.entries(hook.reply?.requests ?? {})) {
                    // Approval controls are independent of terminal answer order. A derived approval can outlive the
                    // canonical receipt, so send them before the normal done/order gates.
                    for (const control of Object.values(receipt.controls ?? {})) {
                        // A draft string lacks a descriptor. It can never leave the process and is normalized only by a
                        // fresh tool call with the exact descriptor.
                        if (
                            typeof control !== "string" &&
                            !control.acknowledged &&
                            !control.inactive &&
                            control.nextAt <= Date.now()
                        ) {
                            await this.#sendControl(
                                hook,
                                key,
                                receipt.request,
                                control.file,
                                control.status,
                            ).catch(() => undefined);
                        }
                    }

                    if (receipt.done || this.#waitsForEarlier(hook, key, receipt)) {
                        continue;
                    }

                    const pending = receipt.pending ?? (await this.#collect(hook, key, receipt));

                    if (pending !== undefined && pending.nextAt <= Date.now()) {
                        await this.#send(
                            hook,
                            key,
                            receipt.request,
                            receipt.root !== undefined,
                            pending,
                        );
                    }
                }
            }
        } finally {
            this.#busy = false;
        }
    }

    /** A later receipt cannot overtake an earlier pending receipt for one original bridge request. */
    #waitsForEarlier(hook: Hook, key: string, receipt: Receipt): boolean {
        const sequence = receipt.sequence ?? 0;

        return Object.entries(hook.reply?.requests ?? {}).some(
            ([otherKey, other]) =>
                otherKey !== key &&
                other.request === receipt.request &&
                !other.done &&
                (other.sequence ?? 0) < sequence,
        );
    }

    async #collect(hook: Hook, key: string, receipt: Receipt): Promise<Pending | undefined> {
        const session = hook.target as unknown as ConversationId;
        const submission = await this.#app.harness.commit(
            (tx) => tx.submissionByRequest(session, receipt.submissionRequest),
            context,
        );

        if (
            submission?.type !== "input" ||
            (submission.status !== "done" && submission.status !== "unanswered")
        ) {
            return undefined;
        }

        let entry = `unanswered:${submission.id}`;
        let text = "[Pi could not answer this message. Try again later.]";
        let successful = false;

        if (submission.status === "done") {
            const stored = await this.#app.harness.commit(
                (tx) => tx.entry(submission.answer),
                context,
            );
            const answer = stored === undefined ? undefined : projectEntry(stored);

            if (stored?.conversationId !== session) {
                return undefined;
            }

            entry = String(submission.answer);

            if (
                answer?.kind === "assistant" &&
                answer.stopReason !== "aborted" &&
                answer.error === undefined
            ) {
                successful = true;
                text = answer.blocks
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n")
                    .trim();

                if (text === "") {
                    text = "[Pi finished without a text answer.]";
                }
            }
        }

        const pending: Pending = { entry, text, attempts: 0, nextAt: 0 };
        let saved: Pending | undefined;

        await this.#app.harness.commit(async (tx) => {
            const item = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key];

            if (item !== undefined && !item.done) {
                if (item.pending === undefined && item.protocol === 3) {
                    const manifests = await tx.doc(ReplyMediaManifestsDoc, session);
                    const files = successful
                        ? Object.values(manifests.items)
                              .filter(
                                  (manifest) =>
                                      manifest.hookId === hook.id &&
                                      manifest.request === receipt.request &&
                                      manifest.root === (receipt.root ?? key) &&
                                      manifest.conversation === String(session) &&
                                      (manifest.entry === entry ||
                                          (manifest.entry === undefined &&
                                              manifest.submissions.includes(
                                                  receipt.submissionRequest,
                                              ))),
                              )
                              .sort((a, b) =>
                                  `${a.task}:${a.call}`.localeCompare(`${b.task}:${b.call}`),
                              )
                              .map((manifest) => {
                                  manifest.entry = entry;

                                  return { file: descriptor(manifest.file), path: manifest.path };
                              })
                        : [];

                    descriptors(files.map((item) => item.file));
                    pending.media = {
                        conversation: Number(session),
                        root: receipt.root ?? key,
                        derived: receipt.root !== undefined,
                        files,
                    };

                    if (
                        files.length > 0 &&
                        pending.text === "[Pi finished without a text answer.]"
                    ) {
                        pending.text = "";
                    }
                }

                item.pending ??= pending;
                saved = JSON.parse(JSON.stringify(item.pending)) as Pending;
            }
        }, context);

        return saved;
    }

    /** One durable protocol-3 plan owns its terminal entry, manifest, and every retry. */
    async #sendMedia(hook: Hook, key: string, request: string, expected: Pending): Promise<void> {
        let attempt: Pending | undefined;

        await this.#app.harness.commit(async (tx) => {
            const current = (await tx.doc(HooksDoc)).items[hook.id];
            const receipt = current?.reply?.requests?.[key];
            const pending = receipt?.pending;

            if (
                current === undefined ||
                !this.#authorized(current) ||
                receipt?.protocol !== 3 ||
                receipt.done ||
                receipt.request !== request ||
                pending?.entry !== expected.entry ||
                pending.media === undefined ||
                pending.nextAt > Date.now()
            ) {
                return;
            }

            if (
                pending.media.conversation !== current.target ||
                pending.media.root !== (receipt.root ?? key) ||
                pending.media.derived !== (receipt.root !== undefined)
            ) {
                throw new Error("Protocol-3 terminal plan lost its original route.");
            }

            descriptors(pending.media.files.map((item) => item.file));
            pending.attempts = Math.min(20, pending.attempts + 1);
            pending.nextAt = Date.now() + backoffMs(pending.attempts);
            attempt = JSON.parse(JSON.stringify(pending)) as Pending;
        }, context);

        if (attempt?.media === undefined || hook.reply === undefined) {
            return;
        }

        try {
            for (const item of attempt.media.files) {
                if (item.uploaded) {
                    continue;
                }

                const latest = (await this.#app.harness.snapshot(HooksDoc, context))?.items[
                    hook.id
                ];
                const receipt = latest?.reply?.requests?.[key];

                if (
                    latest?.reply === undefined ||
                    !this.#authorized(latest) ||
                    receipt === undefined ||
                    receipt.done ||
                    receipt.pending?.entry !== attempt.entry ||
                    latest.target !== attempt.media.conversation
                ) {
                    return;
                }

                const directory = join(
                    this.#app.workspace.uploadDirectory(
                        attempt.media.conversation as unknown as ConversationId,
                    ),
                    "reply-media",
                );
                const bytes = await readPinnedMedia(item.path, descriptor(item.file), directory);
                const metadata = Buffer.from(
                    JSON.stringify({ request, entry: attempt.entry, file: item.file }),
                ).toString("base64url");
                const timestamp = Date.now();
                const response = await this.#postSigned(
                    latest,
                    new URL("/v2/media/reply", latest.reply.url),
                    new Uint8Array(bytes),
                    {
                        "content-type": "application/octet-stream",
                        "x-pocket-attachment": metadata,
                        "x-pocket-timestamp": String(timestamp),
                        "x-pocket-signature": signReply(
                            latest.reply.secret,
                            timestamp,
                            `${metadata}.${item.file.sha256}`,
                        ),
                    },
                );

                if (!response.ok || (await boundedAnswer(response))?.accepted !== true) {
                    throw new Error("Reply media upload was not acknowledged.");
                }

                await this.#app.harness.commit(async (tx) => {
                    const pending = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key]
                        ?.pending;
                    const saved = pending?.media?.files.find(
                        (candidate) => candidate.file.id === item.file.id,
                    );

                    if (
                        pending?.entry !== attempt!.entry ||
                        saved === undefined ||
                        JSON.stringify(saved.file) !== JSON.stringify(item.file)
                    ) {
                        throw new Error("Reply media terminal binding changed.");
                    }

                    saved.uploaded = true;
                }, context);
            }

            const latest = (await this.#app.harness.snapshot(HooksDoc, context))?.items[hook.id];
            const receipt = latest?.reply?.requests?.[key];
            const pending = receipt?.pending;

            if (
                latest?.reply === undefined ||
                !this.#authorized(latest) ||
                receipt?.done ||
                pending?.entry !== attempt.entry ||
                pending.media === undefined ||
                pending.media.files.some((item) => !item.uploaded) ||
                latest.target !== pending.media.conversation
            ) {
                return;
            }

            const base = JSON.parse(
                replyBody({
                    hook: latest.id,
                    request,
                    session: latest.target,
                    entry: pending.entry,
                    text: pending.text,
                }),
            ) as Record<string, unknown>;
            const body = JSON.stringify({
                ...base,
                protocol: 3,
                derived: pending.media.derived,
                attachments: pending.media.files.map((item) => item.file),
            });
            const timestamp = Date.now();
            const response = await this.#postSigned(latest, new URL(latest.reply.url), body, {
                "content-type": "application/json",
                "x-pocket-timestamp": String(timestamp),
                "x-pocket-signature": signReply(latest.reply.secret, timestamp, body),
            });

            if (response.status === 409) {
                // An upload ACK does not bind its bytes to a logical reply. Expired unbound staging can require
                // the same approved bytes again. Keep the terminal plan unchanged and clear only upload ACKs.
                await this.#app.harness.commit(async (tx) => {
                    const current = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key]
                        ?.pending;

                    if (current?.entry === attempt!.entry) {
                        for (const item of current.media?.files ?? []) {
                            delete item.uploaded;
                        }
                    }
                }, context);
            }

            if (!response.ok || (await boundedAnswer(response))?.accepted !== true) {
                throw new Error("Protocol-3 completion was not acknowledged.");
            }

            await this.#app.harness.commit(async (tx) => {
                const current = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key];

                if (current?.pending?.entry === attempt!.entry && !current.done) {
                    current.done = true;
                    delete current.pending;
                }
            }, context);
        } catch {
            // Keep the exact plan and durable backoff. Lost upload and completion responses retry the same scope.
            this.#app.log(`reply hook ${hook.id}: protocol-3 delivery waits for a retry`);
        }
    }

    async #postSigned(
        hook: Hook,
        url: URL,
        body: string | Uint8Array<ArrayBuffer>,
        headers: Record<string, string>,
    ): Promise<Response> {
        const local =
            url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);

        if (local && url.hostname === "localhost") {
            url.hostname = "127.0.0.1";
        }

        const response = await (local ? fetch : this.#fetchPublic)(url, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            headers: { ...headers, "x-pocket-hook": hook.id },
            body,
        });

        if (!response.ok) {
            await response.body?.cancel();
        }

        return response;
    }

    async #send(
        hook: Hook,
        key: string,
        request: string,
        derived: boolean,
        pending: Pending,
    ): Promise<void> {
        const current = (await this.#app.harness.snapshot(HooksDoc, context))?.items[hook.id];
        const receipt = current?.reply?.requests?.[key];

        if (
            current?.reply === undefined ||
            receipt?.done ||
            receipt?.pending?.entry !== pending.entry
        ) {
            return;
        }

        const person = this.#app.config.userById(current.by);

        if (
            !this.#app.hooks.running ||
            person?.role !== "owner" ||
            !this.#app.canSee(person, current.target as unknown as ConversationId)
        ) {
            return;
        }

        if (receipt.protocol === 3) {
            await this.#sendMedia(current, key, request, pending);

            return;
        }

        const timestamp = Date.now();
        const body = replyBody({
            hook: hook.id,
            request,
            session: hook.target,
            entry: pending.entry,
            text: pending.text,
            ...(derived ? { protocol: 2 as const } : {}),
        });
        let ok = false;

        try {
            const url = new URL(current.reply.url);
            const local =
                url.protocol === "http:" &&
                ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);

            // The owner-only local exception cannot resolve DNS or follow redirects.
            if (local && url.hostname === "localhost") {
                url.hostname = "127.0.0.1";
            }

            const send = local ? fetch : this.#fetchPublic;
            const response = await send(url, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
                headers: {
                    "content-type": "application/json",
                    "x-pocket-hook": hook.id,
                    "x-pocket-timestamp": String(timestamp),
                    "x-pocket-signature": signReply(current.reply.secret, timestamp, body),
                },
                body,
            });

            await response.body?.cancel();
            ok = response.status >= 200 && response.status < 300;
        } catch {
            this.#app.log(`reply hook ${hook.id}: the receiver could not be reached`);
        }

        await this.#app.harness.commit(async (tx) => {
            const item = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key];

            if (item?.pending?.entry !== pending.entry || item.done) {
                return;
            }

            const attempts = pending.attempts + 1;

            if (ok || attempts >= MAX_ATTEMPTS) {
                item.done = true;
                delete item.pending;

                if (!ok) {
                    this.#app.log(`reply hook ${hook.id}: gave up after ${attempts} attempts`);
                }

                return;
            }

            item.pending = { ...pending, attempts, nextAt: Date.now() + backoffMs(attempts) };
        }, context);
    }
}
