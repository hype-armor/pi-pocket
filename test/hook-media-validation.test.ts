import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HooksDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { join } from "node:path";

let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    app = await openApp(scriptedModel(), join(root, "hook-media-validation"));
});
after(async () => {
    await app?.close();
    cleanUp();
});

test("non-protocol-3 or duplicate handles bind no root receipt", async () => {
    const id = await newSession(app);
    const hook = await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Media",
        replyUrl: "http://127.0.0.1:9999/v1/reply",
    });
    const bytes = Buffer.from("file");
    const file = {
        id: "f".repeat(64),
        name: "file.bin",
        mime: "application/octet-stream",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const upload = await app.hooks.upload(
        hook.id,
        hook.path.split("/").at(-1),
        { "x-pocket-attachment": Buffer.from(JSON.stringify(file)).toString("base64url") },
        "media-invalid",
        bytes,
    );
    const post = (protocol: string, attachments: unknown[]) =>
        app.hooks.deliver(hook.id, {
            secret: hook.path.split("/").at(-1),
            headers: { "idempotency-key": "media-invalid", "x-pocket-reply-protocol": protocol },
            body: Buffer.from(JSON.stringify({ text: "x", attachments })),
        });

    await assert.rejects(post("2", [{ handle: upload.handle }]), HttpError);
    await assert.rejects(
        post("3", [{ handle: upload.handle }, { handle: upload.handle }]),
        HttpError,
    );
    assert.equal(
        Object.keys(
            (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook.id]!.reply!
                .requests ?? {},
        ).length,
        0,
    );
});
