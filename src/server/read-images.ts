/** Validate exact image bytes from Durable's read tool before they enter a model transcript. */
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { boundedModelImageBytes } from "./model-images.ts";

type ReadImage = { type: "image"; data: string; mimeType: string };
type ReserveReadImage = (encodedBytes: number) => (() => void) | undefined;
type PrepareImage = typeof boundedModelImageBytes;

/** Match the worker's output ceiling before allocating a decoded copy of Durable's base64 string. */
export const MAX_READ_IMAGE_ENCODED_BYTES = 4.5 * 1024 * 1024;
const MAX_PENDING_READ_IMAGES = 2;
const MAX_PENDING_READ_IMAGE_BYTES = 8 * 1024 * 1024;
const OMITTED_IMAGE = "The image could not be safely inspected or decoded and was omitted.";

/**
 * Reserve the decoded-byte work before base64 decoding. The reserve includes the encoded input because queued closures
 * retain its decoded copy until the single shared Photon worker can run it.
 */
export function createReadImageAdmission(
    maxItems = MAX_PENDING_READ_IMAGES,
    maxBytes = MAX_PENDING_READ_IMAGE_BYTES,
): ReserveReadImage {
    let items = 0;
    let bytes = 0;

    return (encodedBytes) => {
        if (encodedBytes > maxBytes - bytes || items >= maxItems) {
            return undefined;
        }

        items += 1;
        bytes += encodedBytes;
        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;
            items -= 1;
            bytes -= encodedBytes;
        };
    };
}

const reserveReadImage = createReadImageAdmission();

function isReadImage(value: unknown): value is ReadImage {
    if (!value || typeof value !== "object") {
        return false;
    }

    const image = value as Partial<ReadImage>;

    return (
        image.type === "image" &&
        typeof image.data === "string" &&
        typeof image.mimeType === "string"
    );
}

function omitted(result: ToolExecutionResult): ToolExecutionResult {
    return {
        ...result,
        output: [],
        structuredOutput: "",
        isError: true,
        diagnostics: [
            ...(result.diagnostics ?? []),
            { severity: "error", code: "unsupported_image", message: OMITTED_IMAGE },
        ],
    };
}

/** Wrap the active `read` tool without reopening its path after Durable returned the bytes. */
export function boundedReadImages(
    tool: ToolRegistration,
    prepare: PrepareImage = boundedModelImageBytes,
    reserve: ReserveReadImage = reserveReadImage,
): ToolRegistration {
    return {
        ...tool,
        execute: async (args, api, context) => {
            const result = await tool.execute(args, api, context);
            const output = result.output;
            const image = Array.isArray(output) ? output.find(isReadImage) : undefined;

            if (image === undefined) {
                return result;
            }

            // `data` is already Durable-owned input, but Buffer.from() would make an unbounded extra allocation.
            const encodedBytes = Buffer.byteLength(image.data, "ascii");

            if (encodedBytes > MAX_READ_IMAGE_ENCODED_BYTES) {
                return omitted(result);
            }

            const release = reserve(encodedBytes);

            if (release === undefined) {
                return omitted(result);
            }

            try {
                const prepared = await prepare(Buffer.from(image.data, "base64"));
                const safe: ReadImage = {
                    type: "image",
                    data: prepared.data,
                    mimeType: prepared.mimeType,
                };

                return {
                    ...result,
                    output: [safe],
                    structuredOutput: safe,
                };
            } catch {
                return omitted(result);
            } finally {
                release();
            }
        },
    };
}
