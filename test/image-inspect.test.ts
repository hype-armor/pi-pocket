import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectImage, MAX_INPUT_PIXELS } from "../src/server/image-inspect.ts";

function pngChunk(name: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);

    chunk.writeUInt32BE(data.length, 0);
    chunk.write(name, 4, "latin1");
    data.copy(chunk, 8);

    return chunk;
}

function png(width: number, height: number, extra: Buffer[] = []): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", header),
        ...extra,
        pngChunk("IDAT", Buffer.from([0])),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function jpeg(width: number, height: number, extra = Buffer.alloc(0)): Buffer {
    return Buffer.concat([
        Buffer.from([
            0xff,
            0xd8,
            0xff,
            0xc0,
            0,
            8,
            8,
            height >> 8,
            height & 0xff,
            width >> 8,
            width & 0xff,
            1,
        ]),
        extra,
        Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
    ]);
}

function webp(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(30);

    bytes.write("RIFF", 0, "latin1");
    bytes.writeUInt32LE(22, 4);
    bytes.write("WEBPVP8X", 8, "latin1");
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);

    return bytes;
}

test("image inspection identifies real PNG, JPEG, and WebP dimensions without decoding", () => {
    assert.deepEqual(inspectImage(png(1, 2)), { mimeType: "image/png", width: 1, height: 2 });
    assert.deepEqual(inspectImage(jpeg(3, 4)), { mimeType: "image/jpeg", width: 3, height: 4 });
    assert.deepEqual(inspectImage(webp(5, 6)), { mimeType: "image/webp", width: 5, height: 6 });
});

test("image inspection rejects pixel bombs before a decoder can allocate", () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS + 1));

    assert.throws(() => inspectImage(png(side, side)), /too many pixels/);
    assert.throws(() => inspectImage(jpeg(side, side)), /too many pixels/);
    assert.throws(() => inspectImage(webp(side, side)), /too many pixels/);
});

test("image inspection rejects APNG and conflicting JPEG frames", () => {
    assert.throws(
        () => inspectImage(png(1, 1, [pngChunk("acTL", Buffer.alloc(8))])),
        /animated PNG/,
    );
    assert.throws(
        () => inspectImage(jpeg(3, 4, Buffer.from([0xff, 0xc2, 0, 8, 8, 0, 5, 0, 6, 1]))),
        /conflicting image frames/,
    );
});
