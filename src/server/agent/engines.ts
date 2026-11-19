import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { ModelError } from "../capabilities/base";
import { assistant, calls, descriptor, plain, type Connection } from "./model";
import { checkText } from "./context";
import { toolSchemas } from "./catalog";
import { executeTool } from "./resources";
import { save, type Run } from "./store";
import { z } from "zod";
import { ShellApprovalRequired } from "../host-shell/service";

export type Ask = () => Promise<AssistantMessage>;
export function result(
  call: ToolCall,
  text: string,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}
export function unfinished(messages: Message[]) {
  const i = messages.findLastIndex((m) => m.role === "assistant");
  const last = messages[i];
  if (last?.role !== "assistant") return [];
  const done = new Set(
    messages
      .slice(i + 1)
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId),
  );
  return calls(last).filter((c) => !done.has(c.id));
}
function safeError(e: unknown) {
  return e instanceof ModelError
    ? e.message
    : e instanceof z.ZodError
      ? "工具参数无效"
      : "工具执行失败";
}
async function perform(r: Run, call: ToolCall): Promise<ToolResultMessage> {
  if (!r.catalog.tools.some((t) => t.name === call.name))
    return result(call, "工具未装配", true);
  if (call.name === "ask_agent") {
    const p = toolSchemas.ask_agent.safeParse(call.arguments);
    if (!p.success) return result(call, "追问参数无效", true);
    r.pending = {
      interactionId: call.id,
      question: z.object({ question: z.string() }).parse(p.data).question,
    };
    r.status = "waiting_input";
    await save(r);
    throw new ModelError(409, "等待用户回答");
  }
  r.inFlight = call.id;
  await save(r);
  try {
    return result(
      call,
      await executeTool(
        call.name,
        call.arguments,
        r.catalog,
        r.modelId,
        r.sandboxSessionId,
        (text) => checkText(r, text),
        { runId: r._id, toolCallId: call.id },
      ),
    );
  } catch (e) {
    if (e instanceof ShellApprovalRequired) {
      r.pendingApproval = { executionId: e.job.id, command: e.job.command, cwd: e.job.cwd, timeout: e.job.timeout, expiresAt: e.job.expiresAt };
      r.status = "waiting_approval";
      delete r.inFlight;
      await save(r);
      throw new ModelError(409, "等待本机命令审批");
    }
    return result(call, safeError(e), true);
  }
}
async function record(r: Run, message: Message) {
  if (r.status !== "running") throw new ModelError(409, "运行暂停");
  if (message.role === "assistant") {
    if (message.stopReason === "error" || message.stopReason === "aborted")
      throw new ModelError(502, message.errorMessage ?? "模型调用失败");
    const seen = new Set(
      r.messages
        .filter((m) => m.role === "toolResult")
        .map((m) => m.toolCallId),
    );
    if (calls(message).some((c) => seen.has(c.id)))
      throw new ModelError(502, "模型重复使用工具调用 ID");
    r.steps++;
    if (!calls(message).length) {
      r.status = "completed";
      r.answer = plain(message);
    }
  } else if (message.role === "toolResult") {
    delete r.inFlight;
    if (message.toolName === "update_plan" && !message.isError)
      r.plan = z
        .object({ steps: z.array(z.string()) })
        .parse(
          unfinished(r.messages).find((c) => c.id === message.toolCallId)
            ?.arguments,
        ).steps;
  }
  r.messages.push(message);
  await save(r);
}
export async function drive(
  r: Run,
  conn: Connection,
  ask: Ask,
  signal: AbortSignal,
) {
  for (const c of unfinished(r.messages)) await record(r, await perform(r, c));
  if (r.catalog.engine === "default") {
    while (r.status === "running") {
      const m = await ask();
      await record(r, m);
      for (const c of calls(m)) await record(r, await perform(r, c));
    }
    return;
  }
  const { runAgentLoopContinue } = await import("@mariozechner/pi-agent-core");
  const { createAssistantMessageEventStream } =
    await import("@mariozechner/pi-ai");
  const tools: AgentTool[] = r.catalog.tools.map((t) => ({
    ...t,
    label: t.name,
    parameters: t.parameters as unknown as AgentTool["parameters"],
    execute: async (id, args) => {
      const m = await perform(r, {
        type: "toolCall",
        id,
        name: t.name,
        arguments: z.record(z.string(), z.unknown()).parse(args),
      });
      if (m.isError) throw new Error(plain(m));
      return { content: m.content, details: {} };
    },
  }));
  const model = descriptor(conn);
  await runAgentLoopContinue(
    { systemPrompt: "", messages: [...r.messages], tools },
    { model, convertToLlm: (ms) => ms, toolExecution: "sequential" },
    async (event) => {
      if (event.type === "message_end") await record(r, event.message);
    },
    signal,
    async () => {
      const stream = createAssistantMessageEventStream();
      try {
        const m = await ask();
        stream.push({
          type: "done",
          reason: m.stopReason === "toolUse" ? "toolUse" : "stop",
          message: m,
        });
      } catch (e) {
        const m = assistant(model);
        m.stopReason = "error";
        m.errorMessage = safeError(e);
        stream.push({ type: "error", reason: "error", error: m });
      }
      stream.end();
      return stream;
    },
  );
}
