import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";

/** Filesystem primitive only. The caller must prove the live root and exact guard scope before calling it. */
export async function readWorkspaceExport(
    cwd: string,
    conversation: string,
    source: string,
): Promise<Buffer> {
    if (
        !isAbsolute(cwd) ||
        resolve(cwd).split(sep).length > 128 ||
        !/^\d+$/.test(conversation) ||
        source === "" ||
        basename(source) !== source ||
        source === "." ||
        source === ".."
    ) {
        throw new Error("Reply media requires a bounded local workspace and a flat export name.");
    }

    const directories: FileHandle[] = [];
    let sourceFile: FileHandle | undefined;

    try {
        let parent = await open(
            sep,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );

        directories.push(parent);

        for (const component of [
            ...resolve(cwd).split(sep).filter(Boolean),
            ".pi-chat-exports",
            conversation,
        ]) {
            parent = await open(
                `/proc/self/fd/${parent.fd}/${component}`,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            directories.push(parent);
        }

        sourceFile = await open(
            `/proc/self/fd/${parent.fd}/${source}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const before = await sourceFile.stat();

        if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size < 1 ||
            before.size > 20 * 1024 * 1024
        ) {
            throw new Error("Reply media source is not a regular single-link export file.");
        }

        const bytes = Buffer.alloc(before.size);
        let offset = 0;

        while (offset < bytes.length) {
            const next = await sourceFile.read(bytes, offset, bytes.length - offset, offset);

            if (next.bytesRead === 0) {
                throw new Error("Reply media source stopped before its checked size.");
            }

            offset += next.bytesRead;
        }

        const probe = await sourceFile.read(Buffer.alloc(1), 0, 1, before.size);
        const after = await sourceFile.stat();

        if (
            probe.bytesRead !== 0 ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.nlink !== 1
        ) {
            throw new Error("Reply media source changed while it was read.");
        }

        return bytes;
    } finally {
        await sourceFile?.close();
        await Promise.all(directories.reverse().map((directory) => directory.close()));
    }
}
