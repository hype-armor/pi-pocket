import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { ConversationId, LiveState } from "@earendil-works/pi-durable";
import { fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
    ACTIVITY_BATCH_SIZE,
    ACTIVITY_LEASE_MS,
    ACTIVITY_MAX_SENDS,
    ACTIVITY_REFRESH_MS,
    ACTIVITY_TIMEOUT_MS,
    ActivityDelivery,
    activityDetail,
    activityUrl,
    signActivity,
    type ActivityPayload,
} from "../src/server/activity-delivery.ts";
import type { PocketApp } from "../src/server/app.ts";
import { type Hook, HooksDoc } from "../src/server/docs.ts";
import { signReply } from "../src/server/reply-hooks.ts";

test("activity HMAC uses the exact separate domain and Unix milliseconds", () => {
    const body = '{"protocol":1,"state":"working"}';
    const at = 1_800_000_000_000;
    const expected = `sha256=${createHmac("sha256", "secret")
        .update(`activity-v1.${at}.${body}`)
        .digest("hex")}`;

    assert.equal(signActivity("secret", at, body), expected);
    assert.notEqual(signActivity("secret", at, body), signReply("secret", at, body));
    assert.notEqual(signActivity("secret", at, body), signActivity("secret", at + 1, body));
    assert.notEqual(signActivity("secret", at, body), signActivity("secret", at, `${body} `));
});

test("only an exact configured reply path derives the activity endpoint", () => {
    assert.equal(
        activityUrl("http://localhost:8080/v1/reply"),
        "http://localhost:8080/v1/activity",
    );
    assert.equal(activityUrl("https://example.com/v1/reply"), "https://example.com/v1/activity");

    for (const url of [
        "invalid",
        "http://example.com/v1/reply",
        "https://example.com/v1/reply/",
        "https://example.com/prefix/v1/reply",
        "https://example.com/v1/%72eply",
        "https://example.com/v1/reply?secret=value",
        "https://user:pass@example.com/v1/reply",
        "https://example.com/v1/reply#fragment",
    ]) {
        assert.equal(activityUrl(url), undefined, url);
    }
});

test("activity exposes only the current block kind and a safe running tool name", () => {
    const generation: NonNullable<LiveState["generation"]> = {
        attempt: 1,
        message: {
            role: "assistant",
            api: "faux",
            provider: "faux",
            model: "faux-1",
            stopReason: "pending",
            timestamp: 0,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [{ type: "thinking", thinking: "NEVER EXPORT PRIVATE THOUGHT" }],
        },
    };

    assert.deepEqual(activityDetail({ generation }), { state: "thinking" });
    generation.message!.content.push(fauxText("NEVER EXPORT OUTPUT"));
    assert.deepEqual(activityDetail({ generation }), { state: "working" });
    assert.deepEqual(activityDetail({}), { state: "working" });

    const tools: NonNullable<LiveState["tools"]> = [
        { callId: "1", name: "read", status: "running", output: "NEVER EXPORT RESULT" },
    ];

    assert.deepEqual(activityDetail({ tools }), { state: "using", tool: "read" });
    assert.deepEqual(activityDetail({ tools }, true), { state: "working" });
    tools.push({ callId: "2", name: "write", status: "running" });
    assert.deepEqual(activityDetail({ tools }), { state: "working" });
    tools[1]!.status = "pending";
    assert.deepEqual(activityDetail({ tools }), { state: "using", tool: "read" });
    tools[0]!.status = "done";
    assert.deepEqual(activityDetail({ tools, generation }), { state: "working" });

    for (const name of [
        "ask",
        "team",
        "subagent",
        "resource_queue_start",
        "evil\nName",
        "x".repeat(65),
    ]) {
        assert.deepEqual(activityDetail({ tools: [{ callId: "1", name, status: "running" }] }), {
            state: "working",
        });
    }

    assert.deepEqual(
        activityDetail({ generation: { ...generation, retry: { at: 100, error: "PRIVATE" } } }),
        { state: "working" },
    );
    assert.deepEqual(activityDetail({ generation: { ...generation, deferred: { pollAt: 100 } } }), {
        state: "working",
    });
});

type Received = { body: string; payload: ActivityPayload; timestamp: number; signature: string };
const received: Received[] = [];
let receiver: Server;
let replyUrl: string;
let hang = false;

before(async () => {
    receiver = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }

        const body = Buffer.concat(chunks).toString("utf8");

        received.push({
            body,
            payload: JSON.parse(body) as ActivityPayload,
            timestamp: Number(request.headers["x-pocket-timestamp"]),
            signature: String(request.headers["x-pocket-signature"]),
        });

        if (!hang) {
            response.writeHead(503);
            response.end();
        }
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    replyUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/v1/reply`;
});

after(() => {
    receiver.closeAllConnections();
    receiver.close();
});

function fixture() {
    const hook: Hook = {
        id: "hook",
        secret: "inbound",
        by: "owner",
        target: 1,
        name: "Test",
        instructions: "",
        createdAt: 0,
        count: 0,
        reply: {
            url: replyUrl,
            secret: "outbound",
            requests: { key: { request: "root", submissionRequest: "p:owner:root" } },
        },
    };
    const state = {
        submission: { type: "input", status: "placed", id: 10 },
        live: { run: { taskId: 20, inputs: [10], turns: 0 } } as unknown as LiveState,
        waiting: false,
        hooks: { items: { hook } },
    };
    const app = {
        harness: {
            commit: async (read: (tx: unknown) => unknown) =>
                read({
                    doc: async (token: unknown) => (token === HooksDoc ? state.hooks : state.live),
                    submissionByRequest: async (target: ConversationId, request: string) => {
                        assert.equal(Number(target), 1);
                        assert.equal(request, "p:owner:root");

                        return state.submission;
                    },
                }),
        },
        config: { userById: () => ({ role: "owner" }) },
        canSee: () => true,
        hooks: { running: true },
        approvals: { forConversation: () => (state.waiting ? [{}] : []) },
        limits: { waitFor: () => undefined },
    } as unknown as PocketApp;
    const activity = new ActivityDelivery(app);
    const enroll = (token = "a".repeat(64)) => activity.enroll(hook, "key", "p:owner:root", token);

    return { state, hook, activity, enroll };
}

test("exact root binding, queue distinction, leases, monotonic sequences, terminal stopped", async (t) => {
    const { state, activity, enroll } = fixture();
    const start = received.length;

    enroll();
    state.submission.status = "queued";
    await activity.sweep();
    assert.equal(received.length, start, "queued is not actually running");
    state.submission.status = "placed";
    state.live.run!.inputs = [];
    await activity.sweep();
    assert.equal(received.length, start, "an unrelated run is not attributed to the root");
    state.live.run!.inputs = [10 as never];
    await activity.sweep();
    assert.equal(received.length, start + 1);
    const first = received[start]!;

    assert.deepEqual(first.payload, {
        protocol: 1,
        hook: "hook",
        request: "root",
        sequence: 1,
        expiresAt: first.timestamp + ACTIVITY_LEASE_MS,
        state: "working",
        token: "a".repeat(64),
    });
    assert.equal(first.signature, signActivity("outbound", first.timestamp, first.body));
    enroll("b".repeat(64));
    await activity.sweep();
    assert.equal(received.length, start + 1, "duplicates do not replace or refresh the capability");
    t.mock.timers.enable({ apis: ["Date"], now: first.timestamp + ACTIVITY_REFRESH_MS + 10 });
    await activity.sweep();
    assert.equal(received[start + 1]!.payload.sequence, 2);
    assert.equal(received[start + 1]!.payload.token, "a".repeat(64));
    t.mock.timers.reset();
    state.submission.status = "done";
    await activity.sweep();
    assert.equal(received.at(-1)!.payload.state, "stopped");
    assert.equal(received.at(-1)!.payload.sequence, 3);
    await activity.sweep();
    assert.equal(received.length, start + 3, "terminal roots send no later activity");
});

test("waits clear tool details, failed sends do not retry, restart has no original activity", async () => {
    const { state, activity, enroll } = fixture();
    const start = received.length;

    enroll();
    state.live.tools = [{ callId: "tool", name: "read", status: "running" }];
    await activity.sweep();
    assert.equal(received[start]!.payload.tool, "read");
    state.waiting = true;
    await activity.sweep();
    assert.equal(received[start + 1]!.payload.state, "working");
    assert.equal(received[start + 1]!.payload.tool, undefined);
    await activity.sweep();
    assert.equal(received.length, start + 2, "HTTP 503 does not create retries");
    const restarted = fixture().activity;

    await restarted.sweep();
    assert.equal(received.length, start + 2);
    state.submission.status = "unanswered";
    await activity.sweep();
    assert.equal(received.at(-1)!.payload.state, "stopped");
});

test("invalid tokens, derived receipts, completed roots and unsupported paths cannot enroll", async () => {
    const start = received.length;

    for (const token of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
        const { activity, enroll } = fixture();

        enroll(token);
        await activity.sweep();
    }

    for (const kind of ["derived", "done", "path"]) {
        const { hook, activity, enroll } = fixture();

        if (kind === "derived") {
            hook.reply!.requests!.key!.root = "another-root";
        } else if (kind === "done") {
            hook.reply!.requests!.key!.done = true;
        } else {
            hook.reply!.url = replyUrl.replace("/v1/reply", "/custom/reply");
        }

        enroll();
        await activity.sweep();
    }

    assert.equal(received.length, start);
});

test("many queued roots and a stalled probe keep the mutation backlog bounded", async () => {
    const { hook } = fixture();
    const gate = Promise.withResolvers<void>();
    let commits = 0;
    let reads = 0;
    const sampled = new Set<string>();
    let line = Promise.resolve();
    const order: string[] = [];

    const commit = (read: (tx: unknown) => Promise<unknown>) => {
        commits += 1;
        const result = line.then(async () =>
            read({
                doc: async () => {
                    await gate.promise;

                    return { items: { hook } };
                },
                submissionByRequest: async (_target: unknown, request: string) => {
                    reads += 1;
                    sampled.add(request);

                    return { type: "input", status: "queued" };
                },
            }),
        );

        line = result.then(() => {});

        return result;
    };

    const app = {
        harness: { commit },
        config: { userById: () => ({ role: "owner" }) },
        canSee: () => true,
        hooks: { running: true },
    } as unknown as PocketApp;
    const activity = new ActivityDelivery(app);

    hook.reply!.requests = {};

    for (let index = 0; index < 1_000; index += 1) {
        const key = `key-${index}`;
        const request = `request-${index}`;

        hook.reply!.requests[key] = { request, submissionRequest: request };
        activity.enroll(hook, key, request, "a".repeat(64));
    }

    const probing = activity.sweep().then(() => order.push("probe"));

    await Promise.all(Array.from({ length: 100 }, () => activity.sweep()));
    assert.equal(commits, 1, "one stalled probe, not one probe per root or timer tick");
    const admission = commit(async () => {
        order.push("admission");
    });
    const reply = commit(async () => {
        order.push("reply");
    });

    assert.equal(commits, 3);
    gate.resolve();
    await Promise.all([probing, admission, reply]);
    assert.equal(reads, ACTIVITY_BATCH_SIZE, "the probe reads only a bounded batch");
    assert.deepEqual(
        order.filter((item) => item !== "probe"),
        ["admission", "reply"],
    );
    assert.equal(commits, 3, "durable work finishes without any additional activity probe");
    await activity.sweep();
    assert.equal(reads, ACTIVITY_BATCH_SIZE * 2);

    for (let index = 0; index < 30; index += 1) {
        await activity.sweep();
    }

    assert.equal(sampled.size, 1_000, "round-robin probes reach every queued root");
});

function activeRoots(count: number, prefix = "overload") {
    const { hook, state } = fixture();
    const missing = new Set<string>();
    const app = {
        harness: {
            commit: async (read: (tx: unknown) => unknown) =>
                read({
                    doc: async (token: unknown) =>
                        token === HooksDoc ? { items: { hook } } : state.live,
                    submissionByRequest: async (_target: unknown, request: string) =>
                        missing.has(request) ? undefined : state.submission,
                }),
        },
        config: { userById: () => ({ role: "owner" }) },
        canSee: () => true,
        hooks: { running: true },
        approvals: { forConversation: () => [] },
        limits: { waitFor: () => undefined },
    } as unknown as PocketApp;
    const activity = new ActivityDelivery(app);

    hook.reply!.requests = {};

    const enroll = (request: string) => {
        hook.reply!.requests![request] = { request, submissionRequest: request };

        return activity.enroll(hook, request, request, "a".repeat(64));
    };

    for (let index = 0; index < count; index += 1) {
        enroll(`${prefix}-${index}`);
    }

    return { activity, state, hook, missing, enroll };
}

async function microtasksUntil(check: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
        if (check()) {
            return;
        }

        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.ok(check(), "the expected asynchronous work finishes");
}

test("overload gives unsent roots the next send slots without a transport queue", async () => {
    const { activity } = activeRoots(ACTIVITY_BATCH_SIZE);
    const start = received.length;

    for (let index = 0; index < ACTIVITY_BATCH_SIZE / ACTIVITY_MAX_SENDS; index += 1) {
        const before = received.length;

        await activity.sweep();
        assert.equal(received.length - before, ACTIVITY_MAX_SENDS);
    }

    const sent = received.slice(start);

    assert.equal(new Set(sent.map((item) => item.payload.request)).size, ACTIVITY_BATCH_SIZE);
    assert.ok(
        sent.every((item) => item.payload.sequence === 1),
        "no root repeats while another root has no lease",
    );
});

test("a capacity-dropped tool transition sends at the next free probe, not after the refresh delay", async (t) => {
    const { activity, state, missing, enroll } = activeRoots(1, "transition");
    const attempts: ActivityPayload[] = [];
    const gate = Promise.withResolvers<void>();
    let blocked = false;
    let active = 0;

    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        attempts.push(JSON.parse(String(init.body)) as ActivityPayload);
        active += 1;

        try {
            if (blocked) {
                await gate.promise;
            }

            return new Response(null, { status: 200 });
        } finally {
            active -= 1;
        }
    });
    state.live.tools = [{ callId: "read", name: "read", status: "running" }];
    await activity.sweep();
    assert.equal(attempts[0]!.state, "using");
    blocked = true;

    // Terminal refusals occupy the transport slots without leaving queued roots in the sampler.
    for (let index = 0; index < ACTIVITY_MAX_SENDS; index += 1) {
        const request = `not-admitted-${index}`;

        missing.add(request);
        enroll(request)!();
    }

    try {
        await microtasksUntil(() => active === ACTIVITY_MAX_SENDS);
        state.live.generation = { attempt: 1, retry: { at: 10, error: "private" } };
        await activity.sweep();
        assert.equal(attempts.filter((item) => item.request === "transition-0").length, 1);
    } finally {
        blocked = false;
        gate.resolve();
    }

    await microtasksUntil(() => active === 0);
    await activity.sweep();
    const transition = attempts.filter((item) => item.request === "transition-0");

    assert.equal(transition.length, 2);
    assert.equal(transition[1]!.state, "working");
    assert.equal(transition[1]!.tool, undefined);
    assert.equal(transition[1]!.sequence, 2);
});

test("global send fairness reaches all 128 roots under sustained three-tick backpressure", async (t) => {
    const { activity } = activeRoots(128, "pressure");
    const attempts: ActivityPayload[] = [];
    let gate = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        attempts.push(JSON.parse(String(init.body)) as ActivityPayload);
        active += 1;
        maximum = Math.max(maximum, active);
        const current = gate;

        try {
            await current.promise;

            return new Response(null, { status: 200 });
        } finally {
            active -= 1;
        }
    });

    try {
        for (let cycle = 0; cycle < 16; cycle += 1) {
            gate = Promise.withResolvers<void>();
            const before = attempts.length;
            const sending = activity.sweep();

            await microtasksUntil(() => active === ACTIVITY_MAX_SENDS);
            assert.equal(attempts.length - before, ACTIVITY_MAX_SENDS);

            for (let tick = 0; tick < 3; tick += 1) {
                t.mock.timers.tick(250);
                await activity.sweep();
            }

            gate.resolve();
            await sending;
            t.mock.timers.tick(250);
        }
    } finally {
        gate.resolve();
    }

    assert.equal(maximum, ACTIVITY_MAX_SENDS);
    assert.equal(new Set(attempts.map((item) => item.request)).size, 128);
    assert.ok(
        attempts.every((item) => item.sequence === 1),
        "no root repeats before all other active roots get a send slot",
    );
});

test("only the enrollment owner can refuse a root, and admitted roots cannot be refused", async () => {
    const { activity, enroll } = fixture();
    const start = received.length;
    const refuse = enroll();

    assert.equal(typeof refuse, "function");
    assert.equal(enroll("b".repeat(64)), undefined, "a duplicate has no refusal authority");
    refuse!();
    await activity.sweep();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(received.length, start + 1);
    assert.equal(received[start]!.payload.state, "working", "the admitted root stays active");
});

test("a hanging callback times out without blocking other work", async () => {
    const { activity, enroll } = fixture();

    enroll();
    hang = true;
    const start = Date.now();
    let independent = false;
    const sending = activity.sweep();

    await Promise.resolve().then(() => {
        independent = true;
    });
    assert.equal(independent, true);
    await sending;
    hang = false;
    assert.ok(Date.now() - start < ACTIVITY_TIMEOUT_MS + 2_000);
    const stop = activity.start();

    stop();
    const count = received.length;

    await activity.sweep();
    assert.equal(received.length, count, "shutdown discards capabilities");
});
