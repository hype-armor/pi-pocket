// The real Pocket tool must gate one hash-pinned export behind the signed protocol-3 control and owner approval.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HooksDoc, ReplyMediaManifestsDoc } from "../src/server/docs.ts";
import type { MediaDescriptor } from "../src/server/reply-media.ts";
import {
    type App,
    cleanUp,
    context,
    loadTools,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

let app: App;
let server: Server;
let replyUrl: string;
let quotaCalls: number | undefined;
const controls: string[] = [];
const uploads: { headers: Record<string, string | string[] | undefined>; bytes: Buffer }[] = [];
const completions: {
    hook: string;
    request: string;
    protocol: number;
    entry: string;
    derived: boolean;
    attachments: MediaDescriptor[];
}[] = [];

function uploadMetadata(upload: (typeof uploads)[number]): {
    request: string;
    entry: string;
    file: MediaDescriptor;
} {
    assert.equal(typeof upload.headers["x-pocket-attachment"], "string");

    return JSON.parse(
        Buffer.from(upload.headers["x-pocket-attachment"] as string, "base64url").toString("utf8"),
    );
}

before(async () => {
    const model = scriptedModel((request) => {
        if (quotaCalls !== undefined) {
            return quotaCalls++ < 5
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("share_reply_file", {
                              path: "report.txt",
                              mime: "text/plain",
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText("done")]);
        }

        const text = lastText(request as never).text;

        return text.includes("share this")
            ? fauxAssistantMessage(
                  [fauxToolCall("share_reply_file", { path: "report.txt", mime: "text/plain" })],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage([fauxText("done")]);
    });

    app = await openApp(model, join(root, "share-reply-file-data"));
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    app.guard.status = async () => ({ available: true, enabled: true, detail: "test" });
    app.guard.judge = async () => ({
        subject: "test export",
        decision: { action: "allow", source: "test", reason: "test", audited: true },
    });
    server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }

        const bytes = Buffer.concat(chunks);

        if (request.url === "/v2/media/reply") {
            uploads.push({ headers: request.headers, bytes });
        } else {
            const payload = JSON.parse(bytes.toString("utf8")) as { status?: unknown };

            if (typeof payload.status === "string") {
                controls.push(payload.status);
            } else {
                completions.push(payload as (typeof completions)[number]);
            }
        }

        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accepted: true, active: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    replyUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/reply`;
});

after(async () => {
    server?.close();
    await app?.close();
    cleanUp();
});

test("protocol-3 awaiting control precedes owner approval and resolved precedes registration", async () => {
    controls.length = 0;
    const id = await newSession(app);

    await loadTools(app, id, "share_reply_file");
    const exports = join(app.cwdOf(id), ".pi-chat-exports", String(id));

    await mkdir(exports, { recursive: true });
    await writeFile(join(exports, "report.txt"), "exact private bytes");
    const hook = await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Share",
        replyUrl,
    });
    const secret = hook.path.split("/").at(-1)!;

    await app.hooks.deliver(hook.id, {
        secret,
        headers: { "idempotency-key": "share-root", "x-pocket-reply-protocol": "3" },
        body: Buffer.from(JSON.stringify({ text: "share this" })),
    });
    await until(
        () => app.approvals.forConversation(id).length === 1 || !app.isBusy(id),
        "owner approval or an idle tool failure",
    );

    if (app.approvals.forConversation(id).length === 0) {
        const entries = await app.transcripts.allEntries(id, true);

        assert.fail(`share_reply_file ended before approval: ${JSON.stringify(entries)}`);
    }

    assert.deepEqual(controls, ["awaiting-file-approval"]);
    const pending = app.approvals.forConversation(id)[0]!;
    const guest = app.config.addUser("Not owner", "guest").user;

    await assert.rejects(app.answerApproval(pending.id, true, guest), { status: 403 });
    await app.answerApproval(pending.id, true, owner(app));
    await until(() => controls.includes("file-approval-resolved"), "resolved control");
    assert.deepEqual(controls, ["awaiting-file-approval", "file-approval-resolved"]);
    await until(
        async () =>
            Object.keys(
                (await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))?.items ?? {},
            ).length === 1,
        "approved manifest registration",
    );
    const manifest = Object.values(
        (await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))!.items,
    )[0]!;

    assert.equal(manifest.hookId, hook.id);
    assert.equal(manifest.request, "share-root");
    assert.equal(manifest.conversation, String(id));
    assert.equal(manifest.file.name, "report.txt");
    assert.equal(manifest.file.size, Buffer.byteLength("exact private bytes"));
    assert.notEqual(manifest.task, "");
    assert.notEqual(manifest.modelTask, "");
    assert.notEqual(manifest.call, "");
    assert.ok(manifest.submissions.length > 0);
    await until(async () => {
        await app.replies.sweep();

        return completions.some((item) => item.request === "share-root");
    }, "signed file upload and protocol-3 terminal completion");
    const sent = uploads.filter((item) => uploadMetadata(item).request === "share-root");

    const receipt = Object.values(
        (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!.requests!,
    ).find((item) => item.request === "share-root")!;
    const submitted = await app.harness.commit(
        (tx) => tx.submissionByRequest(id, receipt.submissionRequest),
        context,
    );

    assert.ok(submitted?.type === "input" && submitted.status === "done");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.bytes.toString("utf8"), "exact private bytes");
    const metadata = uploadMetadata(sent[0]!);
    const completion = completions.find((item) => item.request === "share-root")!;
    const replySecret = (hook as unknown as { reply: { secret: string } }).reply.secret;
    const timestamp = sent[0]!.headers["x-pocket-timestamp"];
    const signature = `sha256=${createHmac("sha256", replySecret).update(`${timestamp}.${sent[0]!.headers["x-pocket-attachment"]}.${metadata.file.sha256}`).digest("hex")}`;

    assert.equal(sent[0]!.headers["x-pocket-signature"], signature);
    assert.equal(sent[0]!.headers["x-pocket-hook"], hook.id);
    assert.equal(metadata.file.sha256, createHash("sha256").update(sent[0]!.bytes).digest("hex"));
    assert.equal(completion.hook, hook.id);
    assert.equal(completion.protocol, 3);
    assert.equal(completion.derived, false);
    assert.equal(completion.entry, metadata.entry);
    assert.equal(completion.entry, String(submitted.answer));
    assert.deepEqual(completion.attachments, [manifest.file]);
    await until(
        async () =>
            Object.values(
                (await app.harness.snapshot(HooksDoc, context))?.items[hook.id]?.reply?.requests ??
                    {},
            ).some((item) => item.request === "share-root" && item.done === true),
        "durable terminal completion ACK",
    );
    const bound = Object.values(
        (await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))!.items,
    )[0]!;

    assert.equal(bound.entry, completion.entry);
});

test("owner denial resolves the control but never registers media", async () => {
    controls.length = 0;
    const id = await newSession(app);

    await loadTools(app, id, "share_reply_file");
    const exports = join(app.cwdOf(id), ".pi-chat-exports", String(id));

    await mkdir(exports, { recursive: true });
    await writeFile(join(exports, "report.txt"), "denied private bytes");
    const hook = await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Denied",
        replyUrl,
    });

    await app.hooks.deliver(hook.id, {
        secret: hook.path.split("/").at(-1)!,
        headers: { "idempotency-key": "share-denied", "x-pocket-reply-protocol": "3" },
        body: Buffer.from(JSON.stringify({ text: "share this" })),
    });
    await until(() => app.approvals.forConversation(id).length === 1, "denial approval");
    const pending = app.approvals.forConversation(id)[0]!;

    await app.answerApproval(pending.id, false, owner(app));
    await until(() => controls.includes("file-approval-resolved"), "denial resolved control");
    assert.deepEqual(controls, ["awaiting-file-approval", "file-approval-resolved"]);
    assert.equal(
        Object.keys((await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))?.items ?? {})
            .length,
        0,
    );
    await until(async () => {
        await app.replies.sweep();

        return completions.some((item) => item.request === "share-denied");
    }, "denied file terminal reply");
    assert.equal(
        uploads.filter((item) => uploadMetadata(item).request === "share-denied").length,
        0,
    );
    assert.deepEqual(completions.find((item) => item.request === "share-denied")!.attachments, []);
});

test("file quota follows exact inputs across generation handoff", async () => {
    const id = await newSession(app);

    await app.commands.updateSession(id, owner(app), { title: "Media quota regression" });
    await loadTools(app, id, "share_reply_file");
    const exports = join(app.cwdOf(id), ".pi-chat-exports", String(id));

    await mkdir(exports, { recursive: true });
    await writeFile(join(exports, "report.txt"), "approved round bytes");
    const hook = await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Quota",
        replyUrl,
    });

    quotaCalls = 0;

    try {
        await app.hooks.deliver(hook.id, {
            secret: hook.path.split("/").at(-1)!,
            headers: { "idempotency-key": "quota-root", "x-pocket-reply-protocol": "3" },
            body: Buffer.from(JSON.stringify({ text: "share across rounds" })),
        });

        for (let count = 0; count < 5; count++) {
            await until(
                () => app.approvals.forConversation(id).length === 1,
                `round ${count + 1} approval`,
            );
            await app.answerApproval(app.approvals.forConversation(id)[0]!.id, true, owner(app));
        }

        await until(async () => {
            await app.replies.sweep();

            return completions.some((item) => item.request === "quota-root");
        }, "quota-bounded completion");
        const manifests = Object.values(
            (await app.harness.snapshot(ReplyMediaManifestsDoc, id, context))!.items,
        );
        const completion = completions.find((item) => item.request === "quota-root")!;

        assert.equal(manifests.length, 4);
        assert.equal(new Set(manifests.map((item) => item.modelTask)).size, 4);
        assert.equal(completion.attachments.length, 4);
        assert.equal(
            uploads.filter((item) => uploadMetadata(item).request === "quota-root").length,
            4,
        );
        assert.ok(manifests.every((item) => item.entry === completion.entry));
    } finally {
        quotaCalls = undefined;
    }
});
