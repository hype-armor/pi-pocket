/**
 * `/hook/<id>/<secret>`, and `/hook/<id>` with GitHub's signature: posts from other services, which `hooks.ts` turns
 * into messages to Pi. No sign-in and no `X-Pocket` header: the secret is what lets a post in.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { HttpError } from "../errors.ts";
import { MAX_POST } from "../hooks.ts";
import { json, readBody } from "./io.ts";

/**
 * Posts read at once, across hooks and to one hook: a known hook id must not let anyone make the server hold many big
 * bodies, nor keep other hooks' posts out. A post is read before its signature can be checked.
 */
const MAX_READING = 8;
const MAX_READING_HOOK = 2;
let reading = 0;
const readingBy = new Map<string, number>();

/**
 * How long a post's body may take: GitHub sends small bodies fast, and a slow one holds a place. Past it the post is cut
 * off and its connection dropped, so no answer reaches the sender. Tests shorten it.
 */
export const hookReads = { timeoutMs: 15_000 };

/** How many posts are being read now (for tests). */
export const readingNow = (): number => reading;

export async function hookRoute(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    id: string,
    secret: string | undefined,
    action?: string,
): Promise<void> {
    if (action === "capabilities") {
        if (request.method !== "GET") {
            response.setHeader("allow", "GET");

            throw new HttpError(405, "Capabilities take GET.");
        }

        await app.hooks.capabilities(id, secret, request.headers);

        return json(response, 200, { version: 3, maxFileBytes: 20 * 1024 * 1024 });
    }

    if (request.method !== "POST") {
        response.setHeader("allow", "POST");

        throw new HttpError(405, "Webhooks take POST.");
    }

    const upload = action === "upload";
    const limit = upload ? 20 * 1024 * 1024 : MAX_POST;

    // Too big is too big, whether or not the hook is there: the answer says nothing about which ids exist.
    if (Number(request.headers["content-length"] ?? 0) > limit) {
        throw new HttpError(413, "Request too large");
    }

    await app.hooks.precheck(id, secret, request.headers);

    if (reading >= MAX_READING || (readingBy.get(id) ?? 0) >= MAX_READING_HOOK) {
        response.setHeader("retry-after", "10");

        throw new HttpError(503, "Busy: try again soon.");
    }

    let body: Buffer;

    reading += 1;
    readingBy.set(id, (readingBy.get(id) ?? 0) + 1);
    const timer = setTimeout(
        // Dropping the connection: the 408 the handler then writes goes nowhere.
        () => request.destroy(new HttpError(408, "The post took too long")),
        hookReads.timeoutMs,
    );

    try {
        body = await readBody(request, limit);
    } catch (error) {
        // A sender that hung up is not the server's error: no stack in the log for it.
        if (error instanceof HttpError) {
            throw error;
        }

        throw new HttpError(400, "The post did not arrive whole.");
    } finally {
        clearTimeout(timer);
        reading -= 1;
        const left = (readingBy.get(id) ?? 1) - 1;

        if (left > 0) {
            readingBy.set(id, left);
        } else {
            readingBy.delete(id);
        }
    }

    if (upload) {
        const requestId = Array.isArray(request.headers["idempotency-key"])
            ? request.headers["idempotency-key"][0]
            : request.headers["idempotency-key"];

        return json(
            response,
            200,
            await app.hooks.upload(id, secret, request.headers, requestId, body),
        );
    }

    // `deliver` reads authenticated reply and activity capabilities from these unchanged headers.
    const answer = await app.hooks.deliver(id, {
        ...(secret === undefined ? {} : { secret }),
        headers: request.headers,
        body,
    });

    json(response, answer.status, { ok: true, message: answer.message });
}
