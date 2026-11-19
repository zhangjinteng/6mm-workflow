import type { Message } from "@mariozechner/pi-ai";
import { resolveIntegration } from "../capabilities/integrations";
import { moderate } from "../capabilities/providers";
import { ModelError } from "../capabilities/base";
import { audit } from "../capabilities/audit";
import { openCompression } from "../compression/service";
import { tokens } from "../compression/engine";
import { plain, calls } from "./model";
import type { Run } from "./store";

export async function checkText(run: Run, text: string) {
  if (!run.input.censor && !run.input.policyId) return;
  const policy = await resolveIntegration("moderation", run.input.policyId);
  if (!policy) throw new ModelError(503, "缺少审核策略");
  const reviewed = await moderate(policy, text);
  await audit("agentModeration", run._id, reviewed.decision);
  if (reviewed.decision === "reject")
    throw new ModelError(422, "Agent 资料未通过审核");
}
export function transcript(messages: Message[]) {
  return messages.map((m) => ({
    role: m.role,
    text: plain(m),
    ...(m.role === "assistant" ? { calls: calls(m) } : {}),
    ...(m.role === "toolResult"
      ? { callId: m.toolCallId, name: m.toolName }
      : {}),
  }));
}
// Collapse only completed groups. Keep the current user request and latest tool round verbatim.
export async function contextForModel(run: Run, maxContext: number) {
  const messages = run.messages.slice();
  const last = messages.findLastIndex((m) => m.role === "assistant");
  const cut = last > run.historyCount ? last : run.historyCount;
  const data = messages.slice(0, cut).filter((_, i) => i !== run.historyCount);
  const budget = Math.min(6000, Math.floor(maxContext / 5));
  if (data.length === 0 || tokens(JSON.stringify(transcript(data))) <= budget)
    return messages;
  if (run.checkpoint?.cut !== cut) {
    const raw = JSON.stringify(transcript(data));
    await checkText(run, raw);
    const { engine } = await openCompression(run.modelId);
    run.checkpoint = {
      cut,
      text: (await engine.text(raw, Math.max(1, Math.floor(budget / 2)))).text,
    };
  }
  const head: Message = {
    role: "user",
    content: "历史资料摘要\n" + run.checkpoint.text,
    timestamp: run.createdAt.getTime(),
  };
  return [
    head,
    ...(cut > run.historyCount ? [messages[run.historyCount]] : []),
    ...messages.slice(cut),
  ];
}
