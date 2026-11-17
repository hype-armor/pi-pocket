// Protocol-3 handles bind in the same durable root-receipt transaction as the original hook request.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HooksDoc } from "../src/server/docs.ts";
import { readWorkspaceExport } from "../src/server/reply-media-export.ts";
import { HttpError } from "../src/server/errors.ts";
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";

let app: App;
let session: Awaited<ReturnType<typeof newSession>>;

const secretOf = (hook: { path: string }) => hook.path.split("/").at(-1)!;
const run = promisify(execFile);

const file = (bytes: Buffer, id = "a".repeat(64)) => ({
    id,
    name: "photo.jpg",
    mime: "image/jpeg",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
});

before(async () => {
    app = await openApp(scriptedModel(), join(root, "hook-media-data"));
});

beforeEach(async () => {
    session = await newSession(app);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("anchored export preparation rejects symlinks, ancestor swaps, and hardlinks", async () => {
    const root = join(app.cwdOf(session), ".pi-chat-exports");
    const directory = join(root, String(session));
    const name = "safe.bin";
    const source = join(directory, name);

    await rm(root, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(source, "safe");
    assert.equal(
        (await readWorkspaceExport(app.cwdOf(session), String(session), name)).toString(),
        "safe",
    );

    await rm(source);
    await symlink("/etc/passwd", source);
    await assert.rejects(readWorkspaceExport(app.cwdOf(session), String(session), name));

    await rm(root, { recursive: true, force: true });
    await symlink("/tmp", root);
    await assert.rejects(readWorkspaceExport(app.cwdOf(session), String(session), name));

    await rm(root, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(source, "hardlink");
    await link(source, join(directory, "second.bin"));
    await assert.rejects(readWorkspaceExport(app.cwdOf(session), String(session), name));

    await rm(root, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await run("mkfifo", [source]);
    await assert.rejects(readWorkspaceExport(app.cwdOf(session), String(session), name));
});

test("a root receipt atomically binds matching private handles", async () => {
    const hook = await app.commands.addHook(owner(app), {
        target: Number(session),
        name: "Media",
        replyUrl: "http://127.0.0.1:9898/v1/reply",
    });
    const bytes = Buffer.from("private image bytes");
    const descriptor = file(bytes);
    const headers = {
        "x-pocket-attachment": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
    };
    const uploaded = await app.hooks.upload(hook.id, secretOf(hook), headers, "request-1", bytes);
    const repeated = await app.hooks.upload(hook.id, secretOf(hook), headers, "request-1", bytes);

    assert.equal(
        repeated.handle,
        uploaded.handle,
        "a lost upload response recovers the same handle",
    );
    await assert.rejects(
        app.hooks.deliver(hook.id, {
            secret: secretOf(hook),
            headers: { "idempotency-key": "request-1", "x-pocket-reply-protocol": "3" },
            body: Buffer.from(
                JSON.stringify({ text: "photo", attachments: [{ handle: uploaded.handle }] }),
            ),
        }),
        HttpError,
        "the receipt binds before a failed admission",
    );

    const stored = await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT);
    const item = stored!.items[hook.id]!;
    const receipt = Object.values(item.reply!.requests!)[0]!;

    assert.equal(item.media![uploaded.handle]!.boundRequest, "request-1");
    assert.deepEqual(receipt.attachments?.handles, [uploaded.handle]);
    assert.ok(receipt.bodyHash);
    assert.equal((await stat(item.media![uploaded.handle]!.path)).mode & 0o077, 0);

    await assert.rejects(
        app.hooks.deliver(hook.id, {
            secret: secretOf(hook),
            headers: { "idempotency-key": "request-1", "x-pocket-reply-protocol": "3" },
            body: Buffer.from(
                JSON.stringify({ text: "changed", attachments: [{ handle: uploaded.handle }] }),
            ),
        }),
        HttpError,
        "a changed retry cannot replace the receipt body",
    );
});

test("a protocol-3 retry cannot upgrade an older protocol-2 root", async () => {
    const hook = await app.commands.addHook(owner(app), {
        target: Number(session),
        name: "Old root",
        replyUrl: "http://127.0.0.1:9898/v1/reply",
    });
    const body = Buffer.from(JSON.stringify({ text: "old root" }));
    const first = {
        secret: secretOf(hook),
        headers: { "idempotency-key": "protocol-old", "x-pocket-reply-protocol": "2" },
        body,
    };

    await app.hooks.deliver(hook.id, first);
    await app.hooks.deliver(hook.id, {
        ...first,
        headers: { "idempotency-key": "protocol-old", "x-pocket-reply-protocol": "3" },
    });

    const stored = await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT);
    const receipt = Object.values(stored!.items[hook.id]!.reply!.requests!)[0]!;

    assert.equal(receipt.protocol, undefined);
});

test("foreign tasks cannot register reply media from a hook root", async () => {
    const bytes = Buffer.from("private manifest bytes");
    const descriptor = file(bytes, "e".repeat(64));

    await assert.rejects(
        app.replies.registerMedia(
            session,
            999 as never,
            "foreign-call",
            descriptor,
            "/not/a/private/copy",
        ),
        /unambiguous protocol-3 reply root/,
    );
});

test("handles fail closed for another hook or original request", async () => {
    const foreign = await newSession(app);
    const first = await app.commands.addHook(owner(app), {
        target: Number(session),
        name: "First",
        replyUrl: "http://127.0.0.1:9898/v1/reply",
    });
    const second = await app.commands.addHook(owner(app), {
        target: Number(foreign),
        name: "Second",
        replyUrl: "http://127.0.0.1:9898/v1/reply",
    });
    const bytes = Buffer.from("private bytes");
    const descriptor = file(bytes, "c".repeat(64));
    const headers = {
        "x-pocket-attachment": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
    };
    const uploaded = await app.hooks.upload(first.id, secretOf(first), headers, "request-a", bytes);

    await assert.rejects(
        app.hooks.deliver(second.id, {
            secret: secretOf(second),
            headers: { "idempotency-key": "request-a" },
            body: Buffer.from(JSON.stringify({ attachments: [{ handle: uploaded.handle }] })),
        }),
        HttpError,
    );
    await assert.rejects(
        app.hooks.deliver(first.id, {
            secret: secretOf(first),
            headers: { "idempotency-key": "request-b" },
            body: Buffer.from(JSON.stringify({ attachments: [{ handle: uploaded.handle }] })),
        }),
        HttpError,
    );
});

test("an interrupted admission leaves the exact root receipt reusable", async () => {
    const hook = await app.commands.addHook(owner(app), {
        target: Number(session),
        name: "Interrupted",
        replyUrl: "http://127.0.0.1:9898/v1/reply",
    });
    const bytes = Buffer.from("retry bytes");
    const descriptor = file(bytes, "d".repeat(64));
    const headers = {
        "x-pocket-attachment": Buffer.from(JSON.stringify(descriptor)).toString("base64url"),
    };
    const uploaded = await app.hooks.upload(
        hook.id,
        secretOf(hook),
        headers,
        "request-retry",
        bytes,
    );
    const post = {
        secret: secretOf(hook),
        headers: { "idempotency-key": "request-retry", "x-pocket-reply-protocol": "3" },
        body: Buffer.from(
            JSON.stringify({ text: "retry", attachments: [{ handle: uploaded.handle }] }),
        ),
    };
    const commands = app.commands as unknown as { submit: typeof app.commands.submit };
    const submit = commands.submit;

    commands.submit = async () => {
        throw new Error("admission interrupted");
    };

    try {
        await assert.rejects(app.hooks.deliver(hook.id, post), /session does not take messages/);
    } finally {
        commands.submit = submit;
    }

    await assert.rejects(app.hooks.deliver(hook.id, post), HttpError);

    const stored = await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT);

    assert.equal(
        stored!.items[hook.id]!.media![uploaded.handle]!.boundRequest,
        "request-retry",
        "an exact retry keeps the prior root binding after interrupted admission",
    );
});
