/**
 * Attached images, made small enough for the model. Making one takes a second or more in a resize worker, so it starts as
 * the upload ends (`prepareModelImage`), while the person still writes: the message that sends it finds it ready
 * (`modelImage`). A file not prepared (after a restart, or one that left the cache) is made then.
 */
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote } from "@earendil-works/pi-coding-agent";
import { HEIC_TYPES, heicToJpeg } from "./heic.ts";
import { inspectImage, type InspectedImage } from "./image-inspect.ts";

/** Attached images that also go to the model itself, when it takes images. */
export const IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    ...HEIC_TYPES,
]);
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

/** How many prepared images are kept: each holds up to about 4.5 MB of base64, mostly well under 1 MB. */
const KEPT = 24;
/**
 * One decode at a time on this 1-CPU host. Photon can allocate outside V8, so worker resource limits do not cap total
 * native or WebAssembly RSS.
 */
const AT_ONCE = 1;
/** Uploads made ready ahead of a send wait at most this many deep; one past it is made when its message goes. */
const AHEAD = 24;
/** The resize worker has a short wall-clock budget and small V8 limits. WASM is bounded by input pixels, not this heap. */
const RESIZE_LIMIT = { ms: 15_000, heapMb: 128, youngHeapMb: 16, stackMb: 4 };

type ResizedImage = {
    data: string;
    mimeType: string;
    originalWidth: number;
    originalHeight: number;
    width: number;
    height: number;
    wasResized: boolean;
};

/**
 * An image for the model, and the note for its attachment line when the model gets something other
 * than the file.
 */
export type ModelImage = { image: ImageContent; note?: string };

/** A prepared image, with the file's stamp before it was read: a file changed since is read again. */
const prepared = new Map<string, { stamp: string; made: Promise<ModelImage> }>();
let running = 0;
const queue: (() => void)[] = [];

/** Run `job` when one of the `AT_ONCE` places is free; a message that waits for it goes ahead of uploads. */
function inTurn<T>(job: () => Promise<T>, first: boolean): Promise<T> {
    return new Promise((resolve, reject) => {
        const run = () => {
            running += 1;
            job()
                .then(resolve, reject)
                .finally(() => {
                    running -= 1;
                    queue.shift()?.();
                });
        };

        if (running < AT_ONCE) {
            run();
        } else if (first) {
            queue.unshift(run);
        } else {
            queue.push(run);
        }
    });
}

/** How many images are being made, and how many wait their turn. */
export function imageWork(): { running: number; waiting: number } {
    return { running, waiting: queue.length };
}

/** Whether an attached file goes to the model as an image. */
export function forModel(mime: string, size: number): boolean {
    return IMAGE_TYPES.has(mime) && size <= MAX_INLINE_IMAGE;
}

const stampOf = (info: { mtimeMs: number; size: number }) => `${info.mtimeMs}:${info.size}`;

/** A short-lived worker contains Photon decode, resize, and its WebAssembly allocations. */
function resizeInWorker(bytes: Uint8Array, image: InspectedImage): Promise<ResizedImage> {
    const stopped = new Error("the image took too much time or memory to resize");
    const copy = new Uint8Array(bytes);

    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./model-image-worker.ts", import.meta.url), {
            workerData: { bytes: copy, ...image },
            transferList: [copy.buffer],
            resourceLimits: {
                maxOldGenerationSizeMb: RESIZE_LIMIT.heapMb,
                maxYoungGenerationSizeMb: RESIZE_LIMIT.youngHeapMb,
                stackSizeMb: RESIZE_LIMIT.stackMb,
            },
        });
        let outcome: { result: ResizedImage } | { error: Error } | undefined;
        const timer = setTimeout(() => {
            outcome = { error: stopped };
            void worker.terminate();
        }, RESIZE_LIMIT.ms);

        worker.once("message", (reply: { result?: ResizedImage; error?: string }) => {
            outcome =
                reply.result === undefined
                    ? { error: new Error(reply.error ?? "the image could not be resized") }
                    : { result: reply.result };
            void worker.terminate();
        });
        worker.once("error", (error: Error & { code?: string }) => {
            outcome = { error: error.code === "ERR_WORKER_OUT_OF_MEMORY" ? stopped : error };
        });
        // Wait for worker exit before the queue starts another decoder. This keeps the one-worker cap real.
        worker.once("exit", () => {
            clearTimeout(timer);

            if (outcome !== undefined && "result" in outcome) {
                resolve(outcome.result);
            } else {
                reject(outcome?.error ?? stopped);
            }
        });
    });
}

/** Inspect exact bytes and then decode them in the one-worker queue. */
async function prepareBoundedImageBytes(bytes: Uint8Array): Promise<ResizedImage> {
    // Do not hand ordinary containers to Photon until their real dimensions pass this parser.
    const inspected = inspectImage(bytes);

    return resizeInWorker(bytes, inspected);
}

/**
 * Validate exact bytes that a caller already holds. This shares the attachment queue with uploads,
 * so a read-tool image cannot start a second Photon decode beside one of them.
 */
export function boundedModelImageBytes(bytes: Uint8Array): Promise<ResizedImage> {
    return inTurn(() => prepareBoundedImageBytes(bytes), false);
}

/**
 * An image file for the model, at most 2000 pixels a side as Pi's read tool sends images: models refuse bigger ones once
 * a conversation holds many, and then every request fails until they leave its context. A HEIC or
 * HEIF photo is made JPEG first. The note says what differs from the file: the format, then the
 * size in the words of Pi's read tool.
 */
function make(path: string, mimeType: string, first: boolean): Promise<ModelImage> {
    return inTurn(async () => {
        let bytes: Uint8Array = await readFile(path);

        if (HEIC_TYPES.has(mimeType)) {
            bytes = await heicToJpeg(bytes);
        }

        const image = await prepareBoundedImageBytes(bytes);

        const notes: string[] = [];

        if (image.mimeType !== mimeType) {
            notes.push(`[Image: shown to you as ${image.mimeType.split("/")[1]!.toUpperCase()}.]`);
        }

        const size = formatDimensionNote(image);

        if (size !== undefined) {
            notes.push(size);
        }

        return {
            image: { type: "image", mimeType: image.mimeType, data: image.data },
            note: notes.length === 0 ? undefined : notes.join(" "),
        };
    }, first);
}

/** Start making an uploaded image ready for the model, if it is one: its failure shows when a message sends it. */
export function prepareModelImage(path: string, mimeType: string, size: number): void {
    if (!forModel(mimeType, size) || prepared.has(path) || queue.length >= AHEAD) {
        return;
    }

    let stamp: string;

    try {
        stamp = stampOf(statSync(path));
    } catch {
        return;
    }

    const made = make(path, mimeType, false);

    made.catch(() => undefined);
    prepared.set(path, { stamp, made });

    while (prepared.size > KEPT) {
        prepared.delete(prepared.keys().next().value!);
    }
}

/** An attached image as the model gets it: the one prepared at upload while its file is unchanged, or made now. */
export async function modelImage(path: string, mimeType: string): Promise<ModelImage> {
    const entry = prepared.get(path);

    if (entry !== undefined) {
        try {
            const made = await entry.made;

            if (stampOf(await stat(path)) === entry.stamp) {
                return made;
            }
        } catch {
            // A failed one is made again, below.
        }

        prepared.delete(path);
    }

    return make(path, mimeType, true);
}
