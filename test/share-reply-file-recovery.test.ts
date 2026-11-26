import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HooksDoc, ReplyMediaManifestsDoc } from "../src/server/docs.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

type Completion = { request: string; entry: string; attachments: unknown[] };
let app: App;
let server: Server;
let replyUrl: string;
let model: ReturnType<typeof scriptedModel>;
let modelCalls = 0;
const directory = join(root, "share-reply-recovery");
const lose = new Set<string>();
const holdCompletion = new Set<string>();
const controls: { request: string; status: string }[] = [];
const uploads: { request: string; metadata: string; bytes: Buffer }[] = [];
const completions: Completion[] = [];

async function reopen() {
    app = await openApp(model, directory);
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    app.guard.status = async () => ({ available: true, enabled: true, detail: "test" });
    app.guard.judge = async () => ({
        subject: "test export",
        decision: { action: "allow", source: "test", reason: "test", audited: true },
    });
}

before(async () => {
    model = scriptedModel((request) => {
        modelCalls++;

        return lastText(request as never).text.includes("share recovery")
            ? fauxAssistantMessage(
                  [fauxToolCall("share_reply_file", { path: "report.txt", mime: "text/plain" })],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage([fauxText("done")]);
    });
    await reopen();
    server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }

        const bytes = Buffer.concat(chunks);
        let key: string;
        let completion: Completion | undefined;

        if (request.url === "/v2/media/reply") {
            const encoded = String(request.headers["x-pocket-attachment"]);
            const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
                request: string;
            };

            uploads.push({ request: metadata.request, metadata: encoded, bytes });
            key = `${metadata.request}:upload`;
        } else {
            const body = JSON.parse(bytes.toString("utf8")) as Completion & { status?: string };

            if (body.status !== undefined) {
                controls.push({ request: body.request, status: body.status });
                key = `${body.request}:${body.status}`;
            } else {
                completions.push(body);
                completion = body;
                key = `${body.request}:completion`;
            }
        }

        if (lose.delete(key)) {
            if (completion !== undefined) {
                holdCompletion.add(completion.request);
            }

            response.destroy();

            return;
        }

        response.setHeader("content-type", "application/json");

        if (completion !== undefined && holdCompletion.has(completion.request)) {
            response.statusCode = 503;
            response.end(JSON.stringify({ accepted: false }));

            return;
        }

        response.end(JSON.stringify({ accepted: true, active: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    replyUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/reply`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function receipt(hook: string, request: string) {
    return Object.values(
        (await app.harness.snapshot(HooksDoc, context))?.items[hook]?.reply?.requests ?? {},
    ).find((item) => item.request === request);
}

async function retry(hook: string, request: string) {
    await app.harness.commit(async (tx) => {
        const saved = Object.values(
            (await tx.doc(HooksDoc)).items[hook]?.reply?.requests ?? {},
        ).find((item) => item.request === request);

        assert.ok(saved);

        for (const control of Object.values(saved.controls ?? {})) {
            control.nextAt = 0;
        }

        if (saved.pending !== undefined) {
            saved.pending.nextAt = 0;
        }
    }, context);
    await app.replies.sweep();
}

async function start(request: string) {
    const id = await newSession(app);

    await loadTools(app, id, "share_reply_file");
    const exports = join(app.cwdOf(id), ".pi-chat-exports", String(id));

    await mkdir(exports, { recursive: true });
    await writeFile(join(exports, "report.txt"), "recoverable approved bytes");
    const hook = await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Recovery",
        replyUrl,
    });

    await app.hooks.deliver(hook.id, {
        secret: hook.path.split("/").at(-1)!,
        headers: { "idempotency-key": request, "x-pocket-reply-protocol": "3" },
        body: Buffer.from(JSON.stringify({ text: "share recovery" })),
    });

    return { id, hook: hook.id };
}

test("lost control responses cannot skip either durable approval ACK", async () => {
    const request = "lost-control-response";

    lose.add(`${request}:awaiting-file-approval`);
    const { id, hook } = await start(request);

    await until(() => controls.some((item) => item.request === request), "first awaiting effect");
    assert.equal(app.approvals.forConversation(id).length, 0);
    assert.ok(
        Object.values((await receipt(hook, request))!.controls!).every(
            (item) => !item.acknowledged,
        ),
    );
    await retry(hook, request);
    await until(() => app.approvals.forConversation(id).length === 1, "approval after retry ACK");
    assert.ok(
        controls.filter(
            (item) => item.request === request && item.status === "awaiting-file-approval",
        ).length >= 2,
    );
    lose.add(`${request}:file-approval-resolved`);
    await app.answerApproval(app.approvals.forConversation(id)[0]!.id, true, owner(app));
    await until(
        () =>
            controls.some(
                (item) => item.request === request && item.status === "file-approval-resolved",
            ),
        "first resolved effect",
    );
    assert.equal(
        Object.keys((await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))?.items ?? {})
            .length,
        0,
    );
    await retry(hook, request);
    await until(async () => {
        await app.replies.sweep();

        return (await receipt(hook, request))?.done === true;
    }, "registered file and terminal completion after resolved retry ACK");
    assert.ok(
        controls.filter(
            (item) => item.request === request && item.status === "file-approval-resolved",
        ).length >= 2,
    );
    assert.equal(
        Object.keys((await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))!.items)
            .length,
        1,
    );
});

test("lost upload and completion responses preserve exact bytes and survive app reopen", async () => {
    const request = "lost-transfer-response";

    lose.add(`${request}:upload`);
    lose.add(`${request}:completion`);
    const { id, hook } = await start(request);

    await until(() => app.approvals.forConversation(id).length === 1, "transfer approval");
    await app.answerApproval(app.approvals.forConversation(id)[0]!.id, true, owner(app));
    await until(async () => {
        await app.replies.sweep();

        return uploads.some((item) => item.request === request);
    }, "first upload effect");
    const first = (await receipt(hook, request))!;

    assert.notEqual(first.done, true);
    assert.equal(first.pending!.media!.files[0]!.uploaded, undefined);
    await retry(hook, request);
    await until(async () => {
        await app.replies.sweep();

        return completions.some((item) => item.request === request);
    }, "uncertain completion effect");
    const before = (await receipt(hook, request))!;

    assert.notEqual(before.done, true);
    assert.equal(before.pending!.media!.files[0]!.uploaded, true);
    const exact = {
        entry: before.pending!.entry,
        text: before.pending!.text,
        media: before.pending!.media,
    };
    const sent = uploads.filter((item) => item.request === request);

    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.metadata, sent[1]!.metadata);
    assert.deepEqual(sent[0]!.bytes, sent[1]!.bytes);
    assert.equal(sent[0]!.bytes.toString("utf8"), "recoverable approved bytes");
    await until(() => !app.isBusy(id), "model task completion before restart");
    const calls = modelCalls;

    await app.close();
    await reopen();
    const restored = (await receipt(hook, request))!;

    assert.deepEqual(
        {
            entry: restored.pending!.entry,
            text: restored.pending!.text,
            media: restored.pending!.media,
        },
        exact,
    );
    assert.equal(app.approvals.forConversation(id).length, 0);
    holdCompletion.delete(request);
    await retry(hook, request);
    await until(async () => {
        await app.replies.sweep();

        return (await receipt(hook, request))?.done === true;
    }, "durable completion ACK after reopen");
    assert.equal(modelCalls, calls);
    assert.equal(uploads.filter((item) => item.request === request).length, 2);
    const replies = completions.filter((item) => item.request === request);

    assert.ok(replies.length >= 2);
    assert.ok(replies.every((item) => JSON.stringify(item) === JSON.stringify(replies[0])));
});
