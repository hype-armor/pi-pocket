// The real Pocket host registers Durable's no-processor read tool. This regression keeps image decoding out of it.
import {
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    say,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
    boundedReadImages,
    createReadImageAdmission,
    MAX_READ_IMAGE_ENCODED_BYTES,
} from "../src/server/read-images.ts";

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (const byte of bytes) {
        crc ^= byte;

        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const name = Buffer.from(type, "latin1");
    const output = Buffer.alloc(12 + data.length);

    output.writeUInt32BE(data.length, 0);
    name.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);

    return output;
}

function png(width: number, height: number): Buffer {
    const header = Buffer.alloc(13);
    const raw = Buffer.alloc(height * (1 + width * 4));

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function malformedPng(): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", Buffer.from([0])),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function oversizedPng(): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        // This intentionally is not compressed image data. The installed no-processor tool must reject by
        // encoded-byte size before a decoder can examine it.
        chunk("IDAT", Buffer.alloc(3.5 * 1024 * 1024)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function returnedReadImage(data: string): ToolRegistration {
    const image = { type: "image" as const, data, mimeType: "image/png" };

    return {
        name: "read",
        description: "Return one image for admission testing.",
        parameters: Type.Object({}),
        execute: async () => ({ output: [image], structuredOutput: image }),
    };
}

const prepared = {
    data: Buffer.from("prepared").toString("base64"),
    mimeType: "image/png",
    originalWidth: 1,
    originalHeight: 1,
    width: 1,
    height: 1,
    wasResized: false,
};

function oversizedFrameGif(): Buffer {
    return Buffer.from([
        ...Buffer.from("GIF89a", "latin1"),
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        0x2c,
        0,
        0,
        0,
        0,
        0xff,
        0xff,
        0xff,
        0xff,
        0,
        2,
        1,
        0,
        0,
        0x3b,
    ]);
}

test("read image wrapper rejects encoded input before it allocates decoded bytes", async () => {
    let calls = 0;
    const tool = boundedReadImages(
        returnedReadImage("A".repeat(MAX_READ_IMAGE_ENCODED_BYTES + 1)),
        async () => {
            calls += 1;

            return prepared;
        },
    );
    const result = await tool.execute({}, {} as never, {} as never);

    assert.equal(calls, 0);
    assert.equal(result.isError, true);
    assert.deepEqual(result.output, []);
    assert.match(
        result.diagnostics?.at(-1)?.message ?? "",
        /could not be safely inspected or decoded and was omitted/,
    );
});

test("read image wrapper bounds queued decoded bytes and releases rejected work", async () => {
    const itemAdmission = createReadImageAdmission(1, 32);
    const releaseItem = itemAdmission(4)!;

    assert.equal(itemAdmission(4), undefined, "a full read-image queue rejects before decoding");
    releaseItem();

    let calls = 0;
    let start!: () => void;
    let rejectFirst!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve) => {
        start = resolve;
    });
    const firstDecoder = new Promise<typeof prepared>((_resolve, reject) => {
        rejectFirst = reject;
    });
    // The first four-byte base64 string reserves 4 bytes. A second has room by item count but not by byte budget.
    const reserve = createReadImageAdmission(2, 7);
    const tool = boundedReadImages(
        returnedReadImage(Buffer.from("x").toString("base64")),
        async () => {
            calls += 1;
            start();

            if (calls === 1) {
                return firstDecoder;
            }

            return prepared;
        },
        reserve,
    );

    const first = tool.execute({}, {} as never, {} as never);

    await started;
    const full = await tool.execute({}, {} as never, {} as never);

    assert.equal(calls, 1);
    assert.equal(full.isError, true);
    assert.deepEqual(full.output, []);

    rejectFirst(new Error("decoder failed"));
    const rejected = await first;

    assert.equal(rejected.isError, true);

    const afterRelease = await tool.execute({}, {} as never, {} as never);

    assert.equal(calls, 2);
    assert.equal(afterRelease.isError, undefined);
});

test("Pocket's installed read tool returns bounded image diagnostics without decoding or resizing", async () => {
    const folder = mkdtempSync(join(root, "read-images-"));
    const dataDir = mkdtempSync(join(root, "read-images-data-"));
    let target = "";
    let readImages = 0;

    const route: FauxResponseStep = (turn) => {
        const { role, text } = lastText(turn as never);

        if (role === "toolResult") {
            const latest = (
                turn as { messages: readonly { role: string; content: unknown }[] }
            ).messages.findLast((message) => message.role === "toolResult");
            const content = latest?.content;

            if (Array.isArray(content)) {
                readImages += content.filter(
                    (part) =>
                        part && typeof part === "object" && "type" in part && part.type === "image",
                ).length;
            }

            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }

        return fauxAssistantMessage([fauxToolCall("read", { path: target })], {
            stopReason: "toolUse",
        });
    };

    const app = await openApp(scriptedModel(route), dataDir);

    try {
        const id = await newSession(app, work);

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-vision" },
            thinkingLevel: "off",
        });
        const wide = join(folder, "wide.png");
        const oversized = join(folder, "oversized.png");
        const oversizedFrame = join(folder, "oversized-frame.gif");
        const malformed = join(folder, "malformed.png");

        writeFileSync(wide, png(2001, 1));
        writeFileSync(oversized, oversizedPng());
        writeFileSync(oversizedFrame, oversizedFrameGif());
        writeFileSync(malformed, malformedPng());

        target = wide;
        await say(app, id, "read the wide image");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /larger than 2000x2000, and no image processor is configured to shrink it/,
        );

        target = oversized;
        await say(app, id, "read the oversized image");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /too large to send, and no image processor is configured to shrink it/,
        );

        target = oversizedFrame;
        await say(app, id, "read the crafted GIF");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /could not be safely inspected or decoded and was omitted/,
        );

        target = malformed;
        await say(app, id, "read the malformed PNG");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /could not be safely inspected or decoded and was omitted/,
        );
        assert.equal(
            readImages,
            0,
            "unsafe read results must not reach the faux model as image blocks",
        );
    } finally {
        await app.close();
        rmSync(folder, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
        cleanUp();
    }
});
