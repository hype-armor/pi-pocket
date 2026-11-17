/**
 * Read dimensions from supported image containers before any decoder sees their bytes.
 * This parser never inflates compressed image data.
 */
export type InspectedImage = {
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    width: number;
    height: number;
};

/** A decoded RGBA image at this size is 64 MB before decoder workspace. */
export const MAX_INPUT_PIXELS = 16_000_000;
const MAX_CHUNKS = 4096;
const MAX_FRAMES = 100;

function dimensions(
    mimeType: InspectedImage["mimeType"],
    width: number,
    height: number,
): InspectedImage {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new Error("the image has invalid dimensions");
    }

    if (width * height > MAX_INPUT_PIXELS) {
        throw new Error("the image has too many pixels");
    }

    return { mimeType, width, height };
}

function png(bytes: Uint8Array): InspectedImage | undefined {
    if (
        bytes.length < 24 ||
        !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ) {
        return;
    }

    const view = Buffer.from(bytes);
    let at = 8;
    let chunks = 0;
    let image: InspectedImage | undefined;
    let hasData = false;

    while (at + 12 <= bytes.length) {
        if (++chunks > MAX_CHUNKS) {
            throw new Error("the PNG has too many chunks");
        }

        const size = view.readUInt32BE(at);
        const name = view.toString("latin1", at + 4, at + 8);
        const data = at + 8;
        const end = data + size;
        const after = end + 4; // CRC

        if (after > bytes.length) {
            throw new Error("the PNG chunk is incomplete");
        }

        if (chunks === 1) {
            if (name !== "IHDR" || size !== 13) {
                throw new Error("the PNG has no image header");
            }

            image = dimensions("image/png", view.readUInt32BE(data), view.readUInt32BE(data + 4));
        } else if (name === "acTL") {
            // APNG can make the decoder allocate and work once for every frame. It is not supported.
            throw new Error("animated PNG images are not supported");
        } else if (name === "IDAT") {
            hasData = true;
        } else if (name === "IEND") {
            if (size !== 0 || image === undefined || !hasData || after !== bytes.length) {
                throw new Error("the PNG data is incomplete");
            }

            return image;
        }

        at = after;
    }

    throw new Error("the PNG data is incomplete");
}

type GifBudget = { blocks: number };

function gifBlocks(bytes: Uint8Array, at: number, budget: GifBudget): number {
    while (at < bytes.length) {
        if (++budget.blocks > MAX_CHUNKS) {
            throw new Error("the GIF has too many data blocks");
        }

        const size = bytes[at++]!;

        if (size === 0) {
            return at;
        }

        if (at + size > bytes.length) {
            throw new Error("the GIF data is incomplete");
        }

        at += size;
    }

    throw new Error("the GIF data is incomplete");
}

function gif(bytes: Uint8Array): InspectedImage | undefined {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("latin1");

    if (bytes.length < 13 || (signature !== "GIF87a" && signature !== "GIF89a")) {
        return;
    }

    const view = Buffer.from(bytes);
    const image = dimensions("image/gif", view.readUInt16LE(6), view.readUInt16LE(8));
    const budget: GifBudget = { blocks: 0 };
    let at = 13;
    let frames = 0;
    let framePixels = 0;

    if (bytes[10]! & 0x80) {
        at += 3 * (1 << ((bytes[10]! & 7) + 1));
    }

    if (at > bytes.length) {
        throw new Error("the GIF color table is incomplete");
    }

    while (at < bytes.length) {
        const block = bytes[at++]!;

        if (block === 0x3b) {
            if (frames === 0) {
                throw new Error("the GIF has no image frame");
            }

            return image;
        }

        if (block === 0x21) {
            if (at >= bytes.length) {
                throw new Error("the GIF extension is incomplete");
            }

            at = gifBlocks(bytes, at + 1, budget);
            continue;
        }

        if (block !== 0x2c || at + 9 > bytes.length) {
            throw new Error("the GIF data is invalid");
        }

        const width = view.readUInt16LE(at + 4);
        const height = view.readUInt16LE(at + 6);

        dimensions("image/gif", width, height);

        if (++frames > MAX_FRAMES || (framePixels += width * height) > MAX_INPUT_PIXELS) {
            throw new Error("the GIF has too many frames or pixels");
        }

        const packed = bytes[at + 8]!;

        at += 9;

        if (packed & 0x80) {
            at += 3 * (1 << ((packed & 7) + 1));
        }

        if (at >= bytes.length) {
            throw new Error("the GIF image data is incomplete");
        }

        at = gifBlocks(bytes, at + 1, budget); // LZW minimum code size, then sub-blocks.
    }

    throw new Error("the GIF has no trailer");
}

function isSof(marker: number): boolean {
    return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

/** Return the next marker after entropy-coded scan bytes, without interpreting image data as markers. */
function scanJpeg(bytes: Uint8Array, at: number): number {
    while (at < bytes.length) {
        if (bytes[at++] !== 0xff) {
            continue;
        }

        while (bytes[at] === 0xff) {
            at += 1;
        }

        const marker = bytes[at];

        if (marker === undefined) {
            break;
        }

        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 1;
            continue;
        }

        return at - 1;
    }

    throw new Error("the JPEG scan is incomplete");
}

function jpeg(bytes: Uint8Array): InspectedImage | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return;
    }

    let at = 2;
    let markers = 0;
    let scans = 0;
    let image: InspectedImage | undefined;

    while (at < bytes.length) {
        if (bytes[at] !== 0xff) {
            throw new Error("the JPEG marker is invalid");
        }

        while (bytes[at] === 0xff) {
            at += 1;
        }

        const marker = bytes[at++];

        if (marker === undefined) {
            break;
        }

        if (++markers > MAX_CHUNKS) {
            throw new Error("the JPEG has too many markers");
        }

        if (marker === 0xd9) {
            if (image === undefined || scans === 0 || at !== bytes.length) {
                throw new Error("the JPEG data is incomplete");
            }

            return image;
        }

        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue;
        }

        if (at + 2 > bytes.length) {
            throw new Error("the JPEG data is incomplete");
        }

        const length = (bytes[at]! << 8) | bytes[at + 1]!;

        if (length < 2 || at + length > bytes.length) {
            throw new Error("the JPEG data is incomplete");
        }

        if (isSof(marker)) {
            if (length < 8) {
                throw new Error("the JPEG frame is incomplete");
            }

            const found = dimensions(
                "image/jpeg",
                (bytes[at + 5]! << 8) | bytes[at + 6]!,
                (bytes[at + 3]! << 8) | bytes[at + 4]!,
            );

            if (
                image !== undefined &&
                (image.width !== found.width || image.height !== found.height)
            ) {
                throw new Error("the JPEG has conflicting image frames");
            }

            image = found;
        }

        if (marker === 0xda) {
            if (image === undefined || ++scans > MAX_FRAMES) {
                throw new Error("the JPEG has invalid image scans");
            }

            at = scanJpeg(bytes, at + length);
            continue;
        }

        at += length;
    }

    throw new Error("the JPEG has no complete image frame");
}

function uint24(bytes: Uint8Array, at: number): number {
    return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function webp(bytes: Uint8Array): InspectedImage | undefined {
    if (
        bytes.length < 12 ||
        Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "RIFF" ||
        Buffer.from(bytes.subarray(8, 12)).toString("latin1") !== "WEBP"
    ) {
        return;
    }

    const view = Buffer.from(bytes);
    const declared = view.readUInt32LE(4) + 8;

    if (declared < 12 || declared > bytes.length) {
        throw new Error("the WebP data is incomplete");
    }

    let at = 12;
    let found: InspectedImage | undefined;
    let frames = 0;
    let framePixels = 0;

    for (let chunks = 0; at + 8 <= declared; chunks += 1) {
        if (chunks >= MAX_CHUNKS) {
            throw new Error("the WebP has too many chunks");
        }

        const name = view.toString("latin1", at, at + 4);
        const size = view.readUInt32LE(at + 4);
        const data = at + 8;
        const end = data + size;

        if (end > declared) {
            throw new Error("the WebP chunk is incomplete");
        }

        if (name === "VP8X" && size >= 10) {
            found = dimensions(
                "image/webp",
                1 + uint24(bytes, data + 4),
                1 + uint24(bytes, data + 7),
            );
        }

        if (name === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
            found = dimensions(
                "image/webp",
                1 + bytes[data + 1]! + ((bytes[data + 2]! & 0x3f) << 8),
                1 +
                    (bytes[data + 2]! >> 6) +
                    (bytes[data + 3]! << 2) +
                    ((bytes[data + 4]! & 0x0f) << 10),
            );
        }

        if (
            name === "VP8 " &&
            size >= 10 &&
            bytes[data + 3] === 0x9d &&
            bytes[data + 4] === 0x01 &&
            bytes[data + 5] === 0x2a
        ) {
            found = dimensions(
                "image/webp",
                view.readUInt16LE(data + 6) & 0x3fff,
                view.readUInt16LE(data + 8) & 0x3fff,
            );
        }

        if (name === "ANMF" && size >= 16) {
            const width = 1 + uint24(bytes, data + 6);
            const height = 1 + uint24(bytes, data + 9);

            dimensions("image/webp", width, height);

            if (++frames > MAX_FRAMES || (framePixels += width * height) > MAX_INPUT_PIXELS) {
                throw new Error("the WebP has too many frames or pixels");
            }
        }

        at = end + (size & 1);
    }

    if (at !== declared && at !== declared + 1) {
        throw new Error("the WebP data is incomplete");
    }

    if (!found) {
        throw new Error("the WebP has no image frame");
    }

    return found;
}

/** Inspect the real container and cap decoded pixels before a decoder runs. */
export function inspectImage(bytes: Uint8Array): InspectedImage {
    const image = png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes);

    if (!image) {
        throw new Error("the file is not a supported image");
    }

    return image;
}
