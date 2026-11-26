/**
 * Triggers start work from outside the app: a PR watch tells Pi when its pull request's checks fail, it has conflicts,
 * or reviewers comment, until it is merged; repository watches tell PiP what happens on the owner's repositories;
 * webhooks turn posts from other services into messages to a session or to PiP. While this is off, watches wait and
 * webhooks answer 503.
 */
import { obj, opt, str, union } from "@earendil-works/pi-schema";
import type { MediaDescriptor } from "../reply-media.ts";
import type { ApprovalAnswer } from "../host.ts";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PrWatch } from "../docs.ts";
import { quoted } from "../fence.ts";
import type { PocketHost } from "../host.ts";
import { endedText, MAX_SENT, TRIGGERS_EXTENSION, WATCH_VIA } from "../watches.ts";
import { literal } from "../tool-schema.ts";

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** A watch in a line, as Pi reads it: a note with no failed look says why it waits. */
export function describeWatch(watch: PrWatch): string {
    const head = `PR #${watch.number} ${quoted(watch.title)} (${watch.url})`;

    if (watch.status !== "watching") {
        return `${head}: watched ${endedText(watch)}.`;
    }

    const checks =
        watch.checks === undefined || watch.checks === "none"
            ? ""
            : `, checks ${watch.checks === "pending" ? "running" : watch.checks}`;

    const note = watch.note?.replace(/\.$/, "");

    const unchecked =
        watch.unchecked === true
            ? `; only the repository owner's comments count: gh's account cannot push to ${watch.repo}, so GitHub does not tell it who else can write there`
            : "";

    return `${head}: watching${checks}, ${watch.sent} of ${watch.max} messages sent${unchecked}${note === undefined ? "" : watch.errors > 0 ? `; last look failed: ${note}` : `; waiting: ${note}`}.`;
}

export default function createTriggers(host: PocketHost) {
    const replyMedia = host as PocketHost & {
        replyApprovalControl?: (
            conversationId: Parameters<typeof host.requesterOf>[0],
            taskId: unknown,
            file: MediaDescriptor,
            status: "awaiting-file-approval" | "file-approval-resolved",
        ) => Promise<void>;
        prepareReplyMedia?: (
            conversationId: Parameters<typeof host.requesterOf>[0],
            taskId: unknown,
            callId: string,
            source: string,
            mime: string,
        ) => Promise<{ file: MediaDescriptor; path: string }>;
        registerReplyMedia?: (
            conversationId: Parameters<typeof host.requesterOf>[0],
            taskId: unknown,
            callId: string,
            file: MediaDescriptor,
            path: string,
        ) => Promise<void>;
    };
    const watchPr = defineTool({
        name: "watch_pr",
        description:
            `Watch this session's pull request on GitHub until it is merged or closed: when its checks fail (with their logs), it has conflicts, or reviewers comment, you get a message starting "[via ${WATCH_VIA}]". ` +
            `Start it after you open a PR (gh pr create) when the person wants it seen through. At most ${MAX_SENT} messages. Actions: start (pr: its number in this folder's repository, or the address or owner/name#12 of one in another repository you can push to; default the PR of the current branch), status, stop.`,
        parameters: obj(
            {
                action: union([literal("start"), literal("status"), literal("stop")]),
                pr: opt(
                    str({
                        description:
                            "start: the PR's number, address, or owner/name#12; default the current branch's",
                    }),
                ),
            },
            { open: true },
        ),
        // Safe to run again: a start finds the watch this very call made, status only reads, and stopping twice is
        // stopping once.
        replay: "safe",
        execute: async (args, api) => {
            if (args.action === "status") {
                const watch = await host.watches.get(api.conversationId);

                return reply(
                    watch === undefined ? "No pull request is watched here." : describeWatch(watch),
                );
            }

            if (args.action === "stop") {
                const watch = await host.watches.stop(api.conversationId);

                return reply(
                    watch === undefined
                        ? "No pull request was watched here."
                        : `Stopped watching PR #${watch.number}.`,
                );
            }

            const watch = await host.watches.start(
                api.conversationId,
                host.requesterOf(api.conversationId),
                {
                    ...(args.pr === undefined ? {} : { pr: args.pr }),
                    byPi: true,
                    key: `${String(api.taskId)}:${api.callId}`,
                },
            );

            return reply(
                `Watching PR #${watch.number} ${quoted(watch.title)}. Messages come when its checks fail, it has conflicts, or reviewers comment; it stops when the PR is merged or closed.`,
            );
        },
    });

    const shareReplyFile = defineTool({
        name: "share_reply_file",
        description:
            "Share one flat export file with the original protocol-3 sender. First write it under .pi-chat-exports/<conversationId>/ in this session's workspace. Give its basename only. Each file is up to 20 MiB; one reply route shares up to 4 files and 40 MiB total. Every file needs owner approval.",
        parameters: obj({ path: str(), mime: str() }),
        // Preparation, controls, approval, and registration use durable call memos and idempotent receipts.
        replay: "safe",
        execute: async (args, api, context) => {
            const guard = await host.guard.status();

            if (!guard.available || !guard.enabled) {
                throw new Error("share_reply_file requires an available enabled Lancet Guard.");
            }

            if (
                replyMedia.replyApprovalControl === undefined ||
                replyMedia.prepareReplyMedia === undefined ||
                replyMedia.registerReplyMedia === undefined
            ) {
                throw new Error("Reply media needs a newer Pocket server.");
            }

            const memoName = "pocket.reply-media.prepared";
            let prepared = await api.memo<{ file: MediaDescriptor; path: string }>(
                memoName,
                context,
            );

            if (prepared === undefined) {
                prepared = await replyMedia.prepareReplyMedia(
                    api.conversationId,
                    api.taskId,
                    api.callId,
                    args.path,
                    args.mime,
                );
                prepared = await api.memo(memoName, prepared, context);
            }

            let approval = await api.memo<ApprovalAnswer>("pocket.reply-media.approval", context);

            if (approval === undefined) {
                await replyMedia.replyApprovalControl(
                    api.conversationId,
                    api.taskId,
                    prepared.file,
                    "awaiting-file-approval",
                );
                approval = await host.approvals.request(
                    {
                        id: `${String(api.taskId)}:${api.callId}:reply-media`,
                        conversationId: api.conversationId,
                        taskId: api.taskId,
                        callId: api.callId,
                        tool: "share_reply_file",
                        subject: `${prepared.file.name} (${prepared.file.sha256})`,
                        reason: "This sends the exact private copy to the original chat sender.",
                        createdAt: Date.now(),
                        ownerOnly: true,
                    },
                    context,
                );
                approval = await api.memo("pocket.reply-media.approval", approval, context);
            }

            await replyMedia.replyApprovalControl(
                api.conversationId,
                api.taskId,
                prepared.file,
                "file-approval-resolved",
            );

            if (!approval.allow) {
                throw new Error("The owner did not approve this file export.");
            }

            await replyMedia.registerReplyMedia(
                api.conversationId,
                api.taskId,
                api.callId,
                prepared.file,
                prepared.path,
            );

            return reply(`Approved ${prepared.file.name} for the original reply route.`);
        },
    });

    // A server started before repository watches has none to run: they come with its restart.
    const repoWatches = (host as Partial<PocketHost>).repoWatches;

    return defineExtension({
        name: TRIGGERS_EXTENSION,
        tasks: [host.watches.task, ...(repoWatches === undefined ? [] : [repoWatches.task])],
        tools: [watchPr, shareReplyFile],
    });
}
