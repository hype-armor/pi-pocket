/**
 * Lancet Guard for Pi Pocket's tools. Before a bash, write, or edit call, the guard from the user's Pi install judges
 * it. Blocks become error results for the model. "Ask" verdicts wait for anyone in the conversation to approve or deny
 * the call in the app. The answer is stored in the call's memo, so a restart after the answer never asks twice.
 */
import { AgentDoc, defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ApprovalAnswer, PocketHost } from "../host.ts";
import { join } from "node:path";

function oneLine(text: string, max = 200): string {
    const flat = text.trim().replace(/[\r\n]+/g, " ");

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function createGuard(host: PocketHost) {
    return defineExtension({
        name: "pocket-guard",
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    const agent = await api.snapshot(AgentDoc, api.conversationId, context);
                    const args = call.arguments as Record<string, unknown>;
                    const exporting = call.name === "share_reply_file";
                    const savedScope = exporting
                        ? await api.memo<{ cwd: string; name: string }>(
                              "pocket.reply-media.guard",
                              context,
                          )
                        : undefined;
                    const cwd = savedScope?.cwd ?? agent?.cwd ?? process.cwd();
                    const scope =
                        exporting && typeof args.path === "string"
                            ? { cwd, name: args.path }
                            : undefined;
                    const judged = await host.guard.judge(
                        call.name,
                        scope === undefined
                            ? args
                            : {
                                  ...args,
                                  path: join(
                                      cwd,
                                      ".pi-chat-exports",
                                      String(api.conversationId),
                                      scope.name,
                                  ),
                              },
                        cwd,
                    );

                    if (judged === undefined) {
                        return undefined;
                    }

                    const { decision, subject } = judged;
                    const scored =
                        typeof decision.score === "number"
                            ? ` (score ${decision.score.toFixed(2)})`
                            : "";

                    if (decision.action === "allow") {
                        if (scope !== undefined) {
                            await api.memo("pocket.reply-media.guard", scope, context);
                        }

                        return undefined;
                    }

                    if (decision.action === "block") {
                        return {
                            block: `Lancet Guard blocked this ${call.name} call: ${decision.reason}${scored}. Call: ${oneLine(subject)}`,
                        };
                    }

                    let answer = await api.memo<ApprovalAnswer>("pocket.approval", context);

                    if (answer === undefined) {
                        const asked = await host.approvals.request(
                            {
                                // The call, not just its task: a codemode script makes several calls in one task, maybe at once.
                                id: `${api.taskId}:${call.id}`,
                                conversationId: api.conversationId,
                                taskId: api.taskId,
                                callId: call.id,
                                tool: call.name,
                                subject,
                                reason: `${decision.reason}${scored}`,
                                ...(decision.score === undefined ? {} : { score: decision.score }),
                                createdAt: Date.now(),
                            },
                            context,
                        );

                        answer = await api.memo<ApprovalAnswer>("pocket.approval", asked, context);
                    }

                    if (answer.allow && scope !== undefined) {
                        await api.memo("pocket.reply-media.guard", scope, context);
                    }

                    return answer.allow
                        ? undefined
                        : {
                              block: `${answer.by} denied this ${call.name} call after Lancet Guard asked (${decision.reason}). Call: ${oneLine(subject)}`,
                          };
                },
            }),
        ],
    });
}
