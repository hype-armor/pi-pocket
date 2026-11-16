import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { forModel, imageWork, modelImage, prepareModelImage } from "../src/server/model-images.ts";
import { heicToJpeg } from "../src/server/heic.ts";

// A 1×1 PNG, and a 2×2 blue one.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);
const BLUE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPgPRmAKABf2A/1+6zfzAAAAAElFTkSuQmCC",
    "base64",
);

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

test("an image prepared at upload is the one a message sends, without making it again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "a.png");

        writeFileSync(path, PNG);
        prepareModelImage(path, "image/png", PNG.length);
        const first = await modelImage(path, "image/png");

        assert.equal(first.image.mimeType, "image/png");
        assert.equal(first.note, undefined, "an image that does not change gets no note");
        // The same object each time: the one prepared, not one made again.
        assert.equal(await modelImage(path, "image/png"), first);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("an image whose file changed after its upload is read again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "a.png");

        writeFileSync(path, PNG);
        prepareModelImage(path, "image/png", PNG.length);
        const before = await modelImage(path, "image/png");

        writeFileSync(path, BLUE);
        assert.equal((await modelImage(path, "image/png")).image.data, BLUE.toString("base64"));
        assert.notEqual(before.image.data, BLUE.toString("base64"));
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("a rejected pixel bomb remains an ordinary file attachment", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "too-large.png");
        const bomb = Buffer.from(PNG);

        bomb.writeUInt32BE(5000, 16);
        bomb.writeUInt32BE(5000, 20);
        writeFileSync(path, bomb);
        await assert.rejects(modelImage(path, "image/png"), /too many pixels/);
        assert.deepEqual(
            readFileSync(path),
            bomb,
            "inspection must not replace the uploaded attachment",
        );
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("the inspected container type, not the declared type, reaches the model", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "wrong-name.jpg");

        writeFileSync(path, PNG);
        const made = await modelImage(path, "image/jpeg");

        assert.equal(made.image.mimeType, "image/png");
        assert.equal(made.note, "[Image: shown to you as PNG.]");
        assert.deepEqual(readFileSync(path), PNG);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("ordinary image resize runs after inspection and leaves the attachment unchanged", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "wide.png");
        const original = png(2001, 1);

        writeFileSync(path, original);
        const made = await modelImage(path, "image/png");

        assert.equal(made.image.mimeType, "image/png");
        assert.equal(
            made.note,
            "[Image: original 2001x1, displayed at 2000x1. Multiply coordinates by 1.00 to map to original image.]",
        );
        assert.deepEqual(readFileSync(path), original);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("uploads make one image at a time, and wait at most 24 deep", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const source = join(folder, "source.png");

        writeFileSync(source, PNG);

        const paths = Array.from({ length: 30 }, (_, n) => join(folder, `${n}.png`));

        for (const path of paths) {
            copyFileSync(source, path);
            prepareModelImage(path, "image/png", PNG.length);
        }

        assert.deepEqual(imageWork(), { running: 1, waiting: 24 });
        await Promise.all(paths.map((path) => modelImage(path, "image/png")));
        assert.deepEqual(imageWork(), { running: 0, waiting: 0 });
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("only images the model takes are prepared", () => {
    assert.equal(forModel("image/png", 1000), true);
    assert.equal(forModel("image/heic", 1000), true);
    assert.equal(forModel("image/heic-sequence", 1000), true);
    assert.equal(forModel("image/png", 6 * 1024 * 1024), false);
});

test("a HEIC photo goes to the model as a JPEG with a note, and the file stays", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "photo.heic");
        const original = readFileSync(new URL("./fixtures/photo.heic", import.meta.url));

        writeFileSync(path, original);
        const made = await modelImage(path, "image/heic");

        assert.equal(made.image.mimeType, "image/jpeg");
        assert.equal(
            Buffer.from(made.image.data, "base64").subarray(0, 3).toString("hex"),
            "ffd8ff",
        );
        assert.equal(made.note, "[Image: shown to you as JPEG.]");
        assert.deepEqual(readFileSync(path), original);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("a broken HEIC file, or one that names too many pixels, fails without a hang", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "bad.heic");
        const photo = readFileSync(new URL("./fixtures/photo.heic", import.meta.url));
        // The photo with the width and height of every `ispe` box set to 65535.
        const huge = Buffer.from(photo);

        for (let at = huge.indexOf("ispe"); at !== -1; at = huge.indexOf("ispe", at + 4)) {
            huge.writeUInt32BE(65535, at + 8);
            huge.writeUInt32BE(65535, at + 12);
        }

        // The photo with no `ispe` box that can be read: its size is not known.
        const unsized = Buffer.from(photo.toString("latin1").replaceAll("ispe", "xxxx"), "latin1");

        // The same photo, with the bytes `ispe` and a huge size in a box after it, as they could be
        // in its data.
        const free = Buffer.alloc(28);

        free.writeUInt32BE(28, 0);
        free.write("freeispe", 4, "latin1");
        free.writeUInt32BE(40000, 16);
        free.writeUInt32BE(40000, 20);
        writeFileSync(path, Buffer.concat([photo, free]));
        assert.equal((await modelImage(path, "image/heic")).image.mimeType, "image/jpeg");

        for (const [bytes, message] of [
            [Buffer.from("....ftypheic not a photo at all"), /./],
            [photo.subarray(0, 300), /./],
            [huge, /too many pixels/],
            [unsized, /size cannot be read/],
        ] as const) {
            writeFileSync(path, bytes);
            await assert.rejects(modelImage(path, "image/heic"), message);
        }
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("HEIC photos convert one at a time, as the decoder's memory is outside the heap", async () => {
    const photo = readFileSync(new URL("./fixtures/photo.heic", import.meta.url));
    const ports = () => process.getActiveResourcesInfo().filter((n) => n === "MessagePort").length;
    let most = 0;
    const timer = setInterval(() => (most = Math.max(most, ports())), 1);

    await Promise.all([heicToJpeg(photo), heicToJpeg(photo), heicToJpeg(photo)]);
    clearInterval(timer);
    assert.equal(most, 1);
});
