/** Media descriptors and private hook upload helpers for reply protocol 3. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { HttpError } from "./errors.ts";

export const MAX_MEDIA_FILE = 20 * 1024 * 1024;
export const MAX_MEDIA_FILES = 4;
export const MAX_MEDIA_TOTAL = 40 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export type MediaDescriptor = {
    id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
};

export function descriptor(raw: unknown): MediaDescriptor {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new HttpError(400, "Bad attachment descriptor");
    }

    const value = raw as Partial<MediaDescriptor>;
    const name = typeof value.name === "string" ? value.name : "";

    if (
        typeof value.id !== "string" ||
        !HEX.test(value.id) ||
        typeof value.sha256 !== "string" ||
        !HEX.test(value.sha256) ||
        basename(name) !== name ||
        name === "." ||
        name === ".." ||
        Buffer.byteLength(name) === 0 ||
        Buffer.byteLength(name) > 200 ||
        /[\p{Cc}\p{Cf}\p{Cs}\\/]/u.test(name) ||
        typeof value.mime !== "string" ||
        value.mime.length > 100 ||
        !MIME.test(value.mime) ||
        value.mime !== value.mime.toLowerCase() ||
        typeof value.size !== "number" ||
        !Number.isSafeInteger(value.size) ||
        value.size < 1 ||
        value.size > MAX_MEDIA_FILE
    ) {
        throw new HttpError(400, "Bad attachment descriptor");
    }

    return { id: value.id, name, mime: value.mime, size: value.size, sha256: value.sha256 };
}

export function descriptors(raw: unknown): MediaDescriptor[] {
    if (!Array.isArray(raw) || raw.length > MAX_MEDIA_FILES) {
        throw new HttpError(400, "Attachments must be a list of up to 4 files");
    }

    const found = raw.map(descriptor);

    if (
        new Set(found.map((file) => file.id)).size !== found.length ||
        found.reduce((n, file) => n + file.size, 0) > MAX_MEDIA_TOTAL
    ) {
        throw new HttpError(400, "Attachments are not valid");
    }

    return found;
}

export function decodeDescriptor(header: string | undefined): MediaDescriptor {
    try {
        return descriptor(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")));
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }

        throw new HttpError(400, "Bad attachment descriptor");
    }
}

export const hashFile = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Read only the bounded private inode whose bytes the owner approved. Never follow a replacement link. */
export async function readPinnedMedia(
    path: string,
    file: MediaDescriptor,
    directory: string,
): Promise<Buffer> {
    const target = resolve(path);
    const parentPath = resolve(directory);

    if (resolve(parentPath, basename(target)) !== target || target === parentPath) {
        throw new Error("Reply media is outside its private directory.");
    }

    const parent = await open(
        parentPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );

    try {
        const source = await open(
            `/proc/self/fd/${parent.fd}/${basename(target)}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );

        try {
            const before = await source.stat();

            if (
                !before.isFile() ||
                before.nlink !== 1 ||
                before.size !== file.size ||
                file.size > MAX_MEDIA_FILE
            ) {
                throw new Error("Reply media is not the approved regular file.");
            }

            const bytes = Buffer.alloc(file.size);
            let offset = 0;

            while (offset < bytes.length) {
                const next = await source.read(bytes, offset, bytes.length - offset, offset);

                if (next.bytesRead === 0) {
                    throw new Error("Reply media ended before its approved size.");
                }

                offset += next.bytesRead;
            }

            const after = await source.stat();

            if (
                after.size !== before.size ||
                after.nlink !== 1 ||
                hashFile(bytes) !== file.sha256
            ) {
                throw new Error("Reply media no longer matches its approved bytes.");
            }

            return bytes;
        } finally {
            await source.close();
        }
    } finally {
        await parent.close();
    }
}

export const handle = () => randomBytes(32).toString("hex");

/** True only for a path directly inside the dedicated export directory. */
export function exportPath(root: string, path: string): string | undefined {
    const target = resolve(path);
    const base = resolve(root);

    return target.startsWith(base + sep) ? target : undefined;
}
