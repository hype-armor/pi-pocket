/** Decode and resize one pre-inspected image in a short-lived worker thread. */
import { parentPort, workerData } from "node:worker_threads";
import * as photon from "@silvia-odwyer/photon-node";
import { MAX_INPUT_PIXELS } from "./image-inspect.ts";

const MAX_SIDE = 2000;
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;

type Request = { bytes: Uint8Array; mimeType: string; width: number; height: number };
type Result = {
    data: string;
    mimeType: string;
    originalWidth: number;
    originalHeight: number;
    width: number;
    height: number;
    wasResized: boolean;
};

function request(value: unknown): value is Request {
    if (!value || typeof value !== "object") {
        return false;
    }

    const data = value as Partial<Request>;

    return (
        data.bytes instanceof Uint8Array &&
        typeof data.mimeType === "string" &&
        Number.isSafeInteger(data.width) &&
        Number.isSafeInteger(data.height)
    );
}

function encoded(
    bytes: Uint8Array,
    mimeType: string,
): { data: string; mimeType: string; size: number } {
    const data = Buffer.from(bytes).toString("base64");

    return { data, mimeType, size: Buffer.byteLength(data) };
}

function target(width: number, height: number): { width: number; height: number } {
    if (width <= MAX_SIDE && height <= MAX_SIDE) {
        return { width, height };
    }

    if (width > height) {
        return { width: MAX_SIDE, height: Math.max(1, Math.round((height * MAX_SIDE) / width)) };
    }

    return { width: Math.max(1, Math.round((width * MAX_SIDE) / height)), height: MAX_SIDE };
}

function resize(input: Request): Result | null {
    const source = photon.PhotonImage.new_from_byteslice(input.bytes);

    try {
        const originalWidth = source.get_width();
        const originalHeight = source.get_height();

        if (
            originalWidth !== input.width ||
            originalHeight !== input.height ||
            originalWidth * originalHeight > MAX_INPUT_PIXELS
        ) {
            throw new Error("the decoded image dimensions do not match its header");
        }

        if (
            originalWidth <= MAX_SIDE &&
            originalHeight <= MAX_SIDE &&
            Math.ceil(input.bytes.byteLength / 3) * 4 < MAX_BASE64_BYTES
        ) {
            return {
                data: Buffer.from(input.bytes).toString("base64"),
                mimeType: input.mimeType,
                originalWidth,
                originalHeight,
                width: originalWidth,
                height: originalHeight,
                wasResized: false,
            };
        }

        const first = target(originalWidth, originalHeight);
        let width = first.width;
        let height = first.height;
        const qualities = [80, 85, 70, 55, 40];

        while (true) {
            const resized = photon.resize(source, width, height, photon.SamplingFilter.Lanczos3);

            try {
                const candidates = [
                    encoded(resized.get_bytes(), "image/png"),
                    ...qualities.map((quality) =>
                        encoded(resized.get_bytes_jpeg(quality), "image/jpeg"),
                    ),
                ];
                const best = candidates.find((candidate) => candidate.size < MAX_BASE64_BYTES);

                if (best) {
                    return {
                        data: best.data,
                        mimeType: best.mimeType,
                        originalWidth,
                        originalHeight,
                        width,
                        height,
                        // The parent sends only an input that exceeds a model dimension or byte limit.
                        wasResized: true,
                    };
                }
            } finally {
                resized.free();
            }

            if (width === 1 && height === 1) {
                return null;
            }

            width = width === 1 ? 1 : Math.max(1, Math.floor(width * 0.75));
            height = height === 1 ? 1 : Math.max(1, Math.floor(height * 0.75));
        }
    } finally {
        source.free();
    }
}

const port = parentPort;

if (!port) {
    throw new Error("model image worker requires parentPort");
}

try {
    if (!request(workerData)) {
        throw new Error("invalid image worker request");
    }

    const result = resize(workerData);

    if (result === null) {
        throw new Error("it could not be made small enough for the model");
    }

    port.postMessage({ result });
} catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
