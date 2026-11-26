// Use an isolated app and data folder. These tests never access the running Pocket server or its data.
import { type App, cleanUp, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
    fauxAssistantMessage,
    fauxThinking,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HooksDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { signActivity, type ActivityPayload } from "../src/server/activity-delivery.ts";
import { verifyReply } from "../src/server/reply-hooks.ts";
import { clientKey, requestFor } from "../src/server/requests.ts";

type Callback = { path: string; body: string; signature: string; timestamp: number };
let app: App;
let receiver: Server;
let pocket: Server;
let callbackUrl: string;
let pocketUrl: string;
let held: Promise<void> | undefined;
let lifecycle = false;
const callbacks: Callback[] = [];

before(async () => {
    const model = scriptedModel(async (context) => {
        await held;

        if (lifecycle) {
            return context.messages.at(-1)?.role === "toolResult"
                ? fauxAssistantMessage("The final answer. ".repeat(1_500))
                : fauxAssistantMessage(
                      [
                          fauxThinking("PRIVATE-THOUGHT ".repeat(2_000)),
                          fauxToolCall("bash", { command: "sleep 1; printf PRIVATE-TOOL-OUTPUT" }),
                      ],
                      { stopReason: "toolUse" },
                  );
        }

        return fauxAssistantMessage("The final answer.");
    });

    app = await openApp(model);
    receiver = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }

        callbacks.push({
            path: request.url!,
            body: Buffer.concat(chunks).toString("utf8"),
            signature: String(request.headers["x-pocket-signature"]),
            timestamp: Number(request.headers["x-pocket-timestamp"]),
        });
        // Activity failures must never prevent the independent final reply.
        response.writeHead(request.url === "/v1/activity" ? 503 : 200);
        response.end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    callbackUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/v1/reply`;
    pocket = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => pocket.listen(0, "127.0.0.1", resolve));
    pocketUrl = `http://127.0.0.1:${(pocket.address() as { port: number }).port}`;
});

after(async () => {
    pocket?.closeAllConnections();
    pocket?.close();
    receiver?.closeAllConnections();
    receiver?.close();
    await app?.close();
    cleanUp();
});

async function hook() {
    const id = await newSession(app);
    const view = await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Activity test",
        replyUrl: callbackUrl,
    });
    const stored = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[view.id]!;

    return { id, path: view.path, hook: stored };
}

async function post(path: string, key: string, headers: Record<string, string> = {}) {
    const response = await fetch(`${pocketUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key, ...headers },
        body: JSON.stringify({
            text: "Original request; PRIVATE INPUT must never enter activity.",
        }),
    });

    await response.body?.cancel();

    return response.status;
}

const forRequest = (request: string, path = "/v1/activity") =>
    callbacks.filter(
        (callback) => callback.path === path && JSON.parse(callback.body).request === request,
    );

test("fresh authenticated capability binds only its root; failures do not interfere with final replies", async () => {
    const { path, hook: stored } = await hook();
    const gate = Promise.withResolvers<void>();
    const token = "a".repeat(64);
    const headers = { "x-pocket-activity-protocol": "1", "x-pocket-activity-token": token };

    held = gate.promise;

    try {
        assert.equal(await post(path.replace(/[^/]+$/, "wrong-secret"), "auth-root", headers), 404);
        await app.activity.sweep();
        assert.equal(forRequest("auth-root").length, 0);
        assert.equal(await post(path, "fresh-root", headers), 202);
        await until(() => forRequest("fresh-root").length > 0, "root activity");
        const first = forRequest("fresh-root")[0]!;
        const payload = JSON.parse(first.body) as ActivityPayload;

        assert.equal(payload.state, "working");
        assert.equal(payload.hook, stored.id);
        assert.equal(payload.token, token);
        assert.equal(payload.sequence, 1);
        assert.equal(
            first.signature,
            signActivity(stored.reply!.secret, first.timestamp, first.body),
        );
        assert.doesNotMatch(first.body, /PRIVATE|text|arguments|output|thinkingText/);
        assert.equal(
            await post(path, "fresh-root", {
                ...headers,
                "x-pocket-activity-token": "b".repeat(64),
            }),
            200,
        );
        const serialized = JSON.stringify(await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT));

        assert.equal(serialized.includes(token), false, "the capability is not durable");
    } finally {
        held = undefined;
        gate.resolve();
    }

    await until(() => forRequest("fresh-root", "/v1/reply").length > 0, "independent final reply");
    const final = forRequest("fresh-root", "/v1/reply")[0]!;

    assert.equal(
        verifyReply(stored.reply!.secret, final.timestamp, final.body, final.signature, Date.now()),
        true,
    );
    await until(
        () => forRequest("fresh-root").some((item) => JSON.parse(item.body).state === "stopped"),
        "terminal activity",
    );
    const count = forRequest("fresh-root").length;

    assert.equal(await post(path, "fresh-root", headers), 200);
    await app.activity.sweep();
    assert.equal(
        forRequest("fresh-root").length,
        count,
        "a completed duplicate never resumes activity",
    );
});

test("protocol 3 media and original activity survive the same HTTP admission", async () => {
    const { path, hook: stored } = await hook();
    const request = "media-activity-root";
    const token = "9".repeat(64);
    const gate = Promise.withResolvers<void>();
    const bytes = Buffer.from("private attachment bytes");
    const descriptor = {
        id: "a".repeat(64),
        name: "note.txt",
        mime: "text/plain",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const uploaded = await fetch(`${pocketUrl}${path}/upload`, {
        method: "POST",
        headers: {
            "idempotency-key": request,
            "x-pocket-attachment": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
        },
        body: bytes,
    });

    assert.equal(uploaded.status, 200);
    const { handle } = (await uploaded.json()) as { handle: string };
    const body = JSON.stringify({ text: "original", attachments: [{ handle }] });
    const headers = {
        "content-type": "application/json",
        "idempotency-key": request,
        "x-pocket-reply-protocol": "3",
        "x-pocket-activity-protocol": "1",
        "x-pocket-activity-token": token,
    };
    const send = (content: string, extra: Record<string, string> = {}) =>
        fetch(`${pocketUrl}${path}`, {
            method: "POST",
            headers: { ...headers, ...extra },
            body: content,
        });

    const submit = app.commands.submit;
    const submissions: Array<Parameters<typeof submit>[2]> = [];
    let mediaPath = "";

    app.commands.submit = (...args) => {
        submissions.push(args[2]);

        return submit.apply(app.commands, args);
    };

    held = gate.promise;

    try {
        const firstResponse = await send(body);

        assert.equal(firstResponse.status, 202, await firstResponse.text());
        await until(() => forRequest(request).length > 0, "media root activity");
        const first = forRequest(request)[0]!;
        const payload = JSON.parse(first.body) as ActivityPayload;

        assert.equal(payload.token, token);
        assert.equal(
            first.signature,
            signActivity(stored.reply!.secret, first.timestamp, first.body),
        );
        assert.equal((await send(body, { "x-pocket-activity-token": "8".repeat(64) })).status, 200);
        assert.equal(
            (await send(JSON.stringify({ text: "changed", attachments: [{ handle }] }))).status,
            409,
        );
        const snapshot = await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT);
        const item = snapshot!.items[stored.id]!;
        const receipt = Object.values(item.reply!.requests!).find(
            (entry) => entry.request === request,
        )!;

        assert.equal(receipt.protocol, 3);
        assert.equal(receipt.followUp, true);
        assert.deepEqual(receipt.attachments?.handles, [handle]);
        assert.equal(item.media![handle]!.boundRequest, request);
        assert.equal(item.media![handle]!.file.sha256, descriptor.sha256);
        mediaPath = item.media![handle]!.path;
        assert.equal(submissions.length, 1);
        assert.deepEqual(submissions[0]!.attachments, [
            {
                path: mediaPath,
                name: descriptor.name,
                mime: descriptor.mime,
                size: descriptor.size,
            },
        ]);
        assert.deepEqual(await readFile(mediaPath), bytes);
        assert.equal(JSON.stringify(snapshot).includes(token), false);
        assert.ok(forRequest(request).every((entry) => JSON.parse(entry.body).token === token));
    } finally {
        app.commands.submit = submit;
        held = undefined;
        gate.resolve();
    }

    await until(() => forRequest(request, "/v1/reply").length === 1, "media root final reply");
    await until(
        () => forRequest(request).some((entry) => JSON.parse(entry.body).state === "stopped"),
        "media root terminal activity",
    );

    for (const entry of forRequest(request)) {
        for (const privateValue of [
            descriptor.name,
            descriptor.sha256,
            handle,
            mediaPath,
            bytes.toString(),
            bytes.toString("base64"),
        ]) {
            assert.equal(
                entry.body.includes(privateValue),
                false,
                "activity excludes media metadata and bytes",
            );
        }
    }
});

test("media records are private in hook views", async () => {
    const { path, hook: stored } = await hook();
    const bytes = Buffer.from("private file");
    const file = {
        id: "b".repeat(64),
        name: "file.txt",
        mime: "text/plain",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const result = await fetch(`${pocketUrl}${path}/upload`, {
        method: "POST",
        headers: {
            "idempotency-key": "private-view",
            "x-pocket-attachment": Buffer.from(JSON.stringify(file)).toString("base64url"),
        },
        body: bytes,
    });

    assert.equal(result.status, 200);
    const view = (await app.hooks.list(owner(app))).find((item) => item.id === stored.id)!;

    assert.equal("media" in view, false);
    const snapshot = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[stored.id]!;
    const managed = app.hooks.view({ ...snapshot, managedReply: true });

    assert.equal("media" in managed, false);
});

test("protocol 2 accepts ordinary JSON attachments as data", async () => {
    const { path } = await hook();
    const response = await fetch(`${pocketUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": "legacy-json",
            "x-pocket-reply-protocol": "2",
        },
        body: JSON.stringify({
            attachments: [{ url: "https://example.invalid/file" }, { handle: "ordinary-data" }],
        }),
    });

    assert.equal(response.status, 202);
});

test("a legacy receipt cannot acquire new media on a retry", async () => {
    const { path, hook: stored } = await hook();
    const request = "legacy-media-retry";
    const key = clientKey(
        `hook-${stored.id}-${createHash("sha256").update(request).digest("base64url").slice(0, 32)}`,
    );
    const bytes = Buffer.from("private file");
    const file = {
        id: "c".repeat(64),
        name: "file.txt",
        mime: "text/plain",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const uploaded = await fetch(`${pocketUrl}${path}/upload`, {
        method: "POST",
        headers: {
            "idempotency-key": request,
            "x-pocket-attachment": Buffer.from(JSON.stringify(file)).toString("base64url"),
        },
        body: bytes,
    });
    const { handle } = (await uploaded.json()) as { handle: string };

    await app.harness.commit(async (tx) => {
        const item = (await tx.doc(HooksDoc)).items[stored.id]!;

        item.reply!.requests = {
            [key]: { request, submissionRequest: requestFor(owner(app).id, key) },
        };
    }, BACKGROUND_CONTEXT);
    const response = await fetch(`${pocketUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": request,
            "x-pocket-reply-protocol": "3",
            "x-pocket-activity-protocol": "1",
            "x-pocket-activity-token": "d".repeat(64),
        },
        body: JSON.stringify({ text: "new media", attachments: [{ handle }] }),
    });

    assert.equal(response.status, 409);
    const snapshot = await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT);

    assert.equal(snapshot!.items[stored.id]!.media![handle]!.boundRequest, undefined);
    await app.activity.sweep();
    assert.equal(forRequest(request).length, 0);
});

test("a durable legacy submission without a receipt cannot bind media on retry", async () => {
    const { id, path, hook: stored } = await hook();
    const request = "evicted-legacy-media";

    assert.equal(await post(path, request, { "x-pocket-reply-protocol": "2" }), 202);
    const key = clientKey(
        `hook-${stored.id}-${createHash("sha256").update(request).digest("base64url").slice(0, 32)}`,
    );

    await app.harness.commit(async (tx) => {
        assert.ok(await tx.submissionByRequest(id, requestFor(owner(app).id, key)));
        const item = (await tx.doc(HooksDoc)).items[stored.id]!;

        delete item.reply!.requests![key];
    }, BACKGROUND_CONTEXT);
    const bytes = Buffer.from("evicted receipt private bytes");
    const descriptor = {
        id: "e".repeat(64),
        name: "evicted.txt",
        mime: "text/plain",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const uploaded = await fetch(`${pocketUrl}${path}/upload`, {
        method: "POST",
        headers: {
            "idempotency-key": request,
            "x-pocket-attachment": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
        },
        body: bytes,
    });

    assert.equal(uploaded.status, 200);
    const { handle } = (await uploaded.json()) as { handle: string };
    const response = await fetch(`${pocketUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": request,
            "x-pocket-reply-protocol": "3",
            "x-pocket-activity-protocol": "1",
            "x-pocket-activity-token": "f".repeat(64),
        },
        body: JSON.stringify({ text: "new media", attachments: [{ handle }] }),
    });

    assert.equal(response.status, 409);
    const snapshot = await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT);

    assert.equal(snapshot!.items[stored.id]!.media![handle]!.boundRequest, undefined);
    await app.activity.sweep();
    assert.equal(forRequest(request).length, 0);
});

test("real HTTP activity follows thinking, tool execution, answer work, and completion", async () => {
    const { path } = await hook();

    lifecycle = true;

    try {
        assert.equal(
            await post(path, "lifecycle-root", {
                "x-pocket-activity-protocol": "1",
                "x-pocket-activity-token": "e".repeat(64),
            }),
            202,
        );
        await until(
            () =>
                forRequest("lifecycle-root").some(
                    (item) => JSON.parse(item.body).state === "stopped",
                ),
            "the full activity lifecycle",
            30_000,
        );
        const states = forRequest("lifecycle-root").map(
            (item) => JSON.parse(item.body) as ActivityPayload,
        );
        const thinking = states.findIndex((item) => item.state === "thinking");
        const using = states.findIndex((item) => item.state === "using" && item.tool === "bash");
        const working = states.findIndex(
            (item, index) => index > using && item.state === "working",
        );

        assert.ok(thinking >= 0);
        assert.ok(using > thinking);
        assert.ok(working > using);
        assert.equal(states.at(-1)!.state, "stopped");
        assert.ok(states.every((item, index) => item.sequence === index + 1));
        assert.ok(forRequest("lifecycle-root").every((item) => !item.body.includes("PRIVATE-")));
        await until(
            () => forRequest("lifecycle-root", "/v1/reply").length === 1,
            "one final reply",
        );
    } finally {
        lifecycle = false;
    }
});

test("cancelling a live original request sends terminal stopped", async () => {
    const { id, path } = await hook();
    const gate = Promise.withResolvers<void>();

    held = gate.promise;

    try {
        assert.equal(
            await post(path, "cancel-root", {
                "x-pocket-activity-protocol": "1",
                "x-pocket-activity-token": "f".repeat(64),
            }),
            202,
        );
        await until(() => forRequest("cancel-root").length > 0, "live cancellation activity");
        const aborting = app.commands.abort(id, owner(app));

        gate.resolve();
        await aborting;
    } finally {
        held = undefined;
        gate.resolve();
    }

    await until(
        () => forRequest("cancel-root").some((item) => JSON.parse(item.body).state === "stopped"),
        "terminal cancellation activity",
    );
    const count = forRequest("cancel-root").length;

    await app.activity.sweep();
    assert.equal(forRequest("cancel-root").length, count);
});

test("a refused concurrent duplicate cannot stop the original enrollment", async () => {
    const { path } = await hook();
    const entered = Promise.withResolvers<void>();
    const admit = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const original = app.commands.submit.bind(app.commands);
    let calls = 0;

    app.commands.submit = async (...args) => {
        calls += 1;

        if (calls === 1) {
            entered.resolve();
            await admit.promise;

            return original(...args);
        }

        throw new Error("Refused duplicate before admission");
    };

    held = answer.promise;
    const headers = {
        "x-pocket-activity-protocol": "1",
        "x-pocket-activity-token": "a".repeat(64),
    };
    const first = post(path, "concurrent-root", headers);

    try {
        await entered.promise;
        assert.equal(await post(path, "concurrent-root", headers), 409);
        admit.resolve();
        assert.equal(await first, 202);
        await until(
            () => forRequest("concurrent-root").length > 0,
            "original activity after duplicate refusal",
        );
        assert.equal(JSON.parse(forRequest("concurrent-root")[0]!.body).state, "working");
    } finally {
        app.commands.submit = original;
        held = undefined;
        admit.resolve();
        answer.resolve();
        await first;
    }

    await until(
        () => forRequest("concurrent-root", "/v1/reply").length === 1,
        "the accepted original reply",
    );
});

test("a refused owner followed by an accepted retry keeps generic activity and final delivery", async () => {
    const { path } = await hook();
    const original = app.commands.submit.bind(app.commands);
    const headers = {
        "x-pocket-activity-protocol": "1",
        "x-pocket-activity-token": "b".repeat(64),
    };

    app.commands.submit = async () => {
        throw new Error("Refused original before admission");
    };

    try {
        assert.equal(await post(path, "refused-root", headers), 409);
        await until(() => forRequest("refused-root").length === 1, "the original enrollment stops");
        assert.equal(JSON.parse(forRequest("refused-root")[0]!.body).state, "stopped");
    } finally {
        app.commands.submit = original;
    }

    assert.equal(await post(path, "refused-root", headers), 202);
    await until(
        () => forRequest("refused-root", "/v1/reply").length === 1,
        "the retry's final reply",
    );
    await app.activity.sweep();
    assert.equal(
        forRequest("refused-root").length,
        1,
        "the retry cannot resume the stopped capability",
    );
});

test("an exception after admission does not stop the accepted original", async () => {
    const { path } = await hook();
    const original = app.commands.submit.bind(app.commands);
    const answer = Promise.withResolvers<void>();

    held = answer.promise;

    app.commands.submit = async (...args) => {
        await original(...args);

        throw new Error("Failure after durable admission");
    };

    try {
        assert.equal(
            await post(path, "post-admission-root", {
                "x-pocket-activity-protocol": "1",
                "x-pocket-activity-token": "c".repeat(64),
            }),
            409,
        );
        await until(
            () => forRequest("post-admission-root").length > 0,
            "activity after an admitted exception",
        );
        assert.equal(JSON.parse(forRequest("post-admission-root")[0]!.body).state, "working");
    } finally {
        app.commands.submit = original;
        held = undefined;
        answer.resolve();
    }

    await until(
        () => forRequest("post-admission-root", "/v1/reply").length === 1,
        "the admitted final reply",
    );
});

test("a durable pre-submission receipt cannot gain activity after restart or retry", async () => {
    const { path, hook: stored } = await hook();
    const request = "pre-restart-root";
    const key = clientKey(
        `hook-${stored.id}-${createHash("sha256").update(request).digest("base64url").slice(0, 32)}`,
    );

    // Simulate a receipt stored by the old process before its submission reached admission.
    await app.harness.commit(async (tx) => {
        const item = (await tx.doc(HooksDoc)).items[stored.id]!;

        item.reply!.requests = {
            [key]: { request, submissionRequest: requestFor(owner(app).id, key) },
        };
    }, BACKGROUND_CONTEXT);
    assert.equal(
        await post(path, request, {
            "x-pocket-activity-protocol": "1",
            "x-pocket-activity-token": "a".repeat(64),
        }),
        202,
    );
    await until(() => forRequest(request, "/v1/reply").length > 0, "the recovered final reply");
    await app.activity.sweep();
    assert.equal(forRequest(request).length, 0);
});

test("legacy and malformed capabilities cannot enroll, and duplicates cannot upgrade them", async () => {
    const { path } = await hook();

    for (const [key, headers] of [
        ["legacy-root", {}],
        ["bad-token-root", { "x-pocket-activity-protocol": "1", "x-pocket-activity-token": "bad" }],
        [
            "bad-protocol-root",
            { "x-pocket-activity-protocol": "2", "x-pocket-activity-token": "c".repeat(64) },
        ],
    ] as const) {
        assert.equal(await post(path, key, headers), 202);
        await until(() => forRequest(key, "/v1/reply").length > 0, "the legacy final reply");
        assert.equal(
            await post(path, key, {
                "x-pocket-activity-protocol": "1",
                "x-pocket-activity-token": "d".repeat(64),
            }),
            200,
        );
        await app.activity.sweep();
        assert.equal(forRequest(key).length, 0);
    }
});
