import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../src/server/errors.ts";
import { decodeDescriptor, descriptors, MAX_MEDIA_FILE } from "../src/server/reply-media.ts";

const file = {
    id: "a".repeat(64),
    name: "photo.jpg",
    mime: "image/jpeg",
    size: 1,
    sha256: "b".repeat(64),
};

test("protocol 3 media descriptors accept only immutable safe metadata", () => {
    assert.deepEqual(
        decodeDescriptor(Buffer.from(JSON.stringify(file)).toString("base64url")),
        file,
    );
    assert.deepEqual(descriptors([file]), [file]);
});

test("protocol 3 media descriptors reject paths, oversized files, and duplicate ids", () => {
    for (const value of [
        { ...file, name: "../secret" },
        { ...file, size: MAX_MEDIA_FILE + 1 },
        { ...file, sha256: "upper".repeat(16) },
    ]) {
        assert.throws(() => descriptors([value]), HttpError);
    }

    assert.throws(() => descriptors([file, file]), HttpError);
});
