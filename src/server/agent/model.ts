import { z } from "zod";
import type {
  AssistantMessage,
  Message,
  ImageContent,
  TextContent,
  ToolCall,
  Model,
} from "@mariozechner/pi-ai";
import { target } from "../capabilities/models";
import { decode, send } from "../capabilities/network";
import { ModelError } from "../capabilities/base";
import { tokens } from "../compression/engine";
import type { Catalog } from "./catalog";
export type Connection = Awaited<ReturnType<typeof target>>;
export function descriptor({
  input: m,
}: Connection): Model<"anthropic-messages" | "openai-completions"> {
  return {
    id: m.upstreamModel,
    name: m.name,
    api:
      m.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider: m.providerId,
    baseUrl: m.baseUrl,
    reasoning: m.capabilities.includes("reasoning"),
    input: m.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.maxContext,
    maxTokens: m.maxResponse,
  };
}
export function assistant(
  model: ReturnType<typeof descriptor>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { ...model.cost, total: 0 },
    },
  };
}
export const plain = (m: Message) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
export const calls = (m: AssistantMessage) =>
  m.content.filter((c): c is ToolCall => c.type === "toolCall");
function media(c: ImageContent | TextContent, anthropic: boolean) {
  if (c.type === "text") return c;
  return anthropic
    ? {
        type: "image",
        source: { type: "base64", media_type: c.mimeType, data: c.data },
      }
    : {
        type: "image_url",
        image_url: { url: "data:" + c.mimeType + ";base64," + c.data },
      };
}
export function wire(m: Message, anthropic: boolean): Record<string, unknown> {
  if (m.role === "user")
    return {
      role: "user",
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => media(c, anthropic)),
    };
  if (m.role === "toolResult")
    return anthropic
      ? {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.toolCallId,
              content: plain(m),
              is_error: m.isError,
            },
          ],
        }
      : { role: "tool", tool_call_id: m.toolCallId, content: plain(m) };
  const reasoning = m.content.filter((c) => c.type === "thinking");
  if (anthropic)
    return {
      role: "assistant",
      content: m.content.map((c) =>
        c.type === "toolCall"
          ? { type: "tool_use", id: c.id, name: c.name, input: c.arguments }
          : c.type === "thinking"
            ? {
                type: "thinking",
                thinking: c.thinking,
                signature: c.thinkingSignature,
              }
            : c,
      ),
    };
  return {
    role: "assistant",
    content: plain(m) || null,
    ...(reasoning.length
      ? { reasoning_content: reasoning.map((c) => c.thinking).join("") }
      : {}),
    ...(calls(m).length
      ? {
          tool_calls: calls(m).map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }
      : {}),
  };
}
const object = z.record(z.string(), z.unknown());
const toolId = z.string().min(1).max(256);
export function parseReply(raw: unknown, conn: Connection) {
  const out = assistant(descriptor(conn));
  if (conn.input.protocol === "anthropic") {
    const r = z
      .object({
        content: z.array(object),
        stop_reason: z.string(),
        usage: z
          .object({ input_tokens: z.number(), output_tokens: z.number() })
          .optional(),
      })
      .parse(raw);
    for (const b of r.content) {
      if (b.type === "text")
        out.content.push({ type: "text", text: z.string().parse(b.text) });
      else if (b.type === "tool_use")
        out.content.push({
          type: "toolCall",
          id: toolId.parse(b.id),
          name: toolId.parse(b.name),
          arguments: object.parse(b.input),
        });
      else if (b.type === "thinking")
        out.content.push({
          type: "thinking",
          thinking: z.string().parse(b.thinking),
          thinkingSignature: z.string().parse(b.signature),
        });
      else throw new ModelError(502, "暂不支持该模型响应块");
    }
    out.usage.input = r.usage?.input_tokens ?? 0;
    out.usage.output = r.usage?.output_tokens ?? 0;
    if (r.stop_reason === "max_tokens") out.stopReason = "length";
  } else {
    const r = z
      .object({
        choices: z
          .array(
            z.object({
              finish_reason: z.string(),
              message: z.object({
                content: z.string().nullish(),
                reasoning_content: z.string().nullish(),
                tool_calls: z
                  .array(
                    z.object({
                      id: toolId,
                      function: z.object({
                        name: toolId,
                        arguments: z.string(),
                      }),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .min(1),
        usage: z
          .object({ prompt_tokens: z.number(), completion_tokens: z.number() })
          .optional(),
      })
      .parse(raw);
    const { message: m, finish_reason } = r.choices[0];
    if (m.reasoning_content)
      out.content.push({ type: "thinking", thinking: m.reasoning_content });
    if (m.content) out.content.push({ type: "text", text: m.content });
    for (const c of m.tool_calls ?? [])
      out.content.push({
        type: "toolCall",
        id: c.id,
        name: c.function.name,
        arguments: object.parse(JSON.parse(c.function.arguments)),
      });
    out.usage.input = r.usage?.prompt_tokens ?? 0;
    out.usage.output = r.usage?.completion_tokens ?? 0;
    if (finish_reason === "length") out.stopReason = "length";
  }
  const ids = calls(out).map((c) => c.id);
  if (
    out.stopReason === "length" ||
    (!ids.length && !plain(out)) ||
    ids.length > 12 ||
    ids.length !== new Set(ids).size
  )
    throw new ModelError(502, "模型回复不完整或工具调用无效");
  if (ids.length) out.stopReason = "toolUse";
  out.usage.totalTokens = out.usage.input + out.usage.output;
  return out;
}
export async function completion(
  conn: Connection,
  system: string,
  messages: Message[],
  tools: Catalog["tools"],
  signal: AbortSignal,
  transport = send,
) {
  const m = conn.input,
    anthropic = m.protocol === "anthropic",
    output = Math.min(4096, m.maxResponse);
  const defs = tools.map(({ name, description, parameters }) => {
    const schema = { ...parameters };
    delete schema.$schema;
    return anthropic
      ? { name, description, input_schema: schema }
      : {
          type: "function",
          function: { name, description, parameters: schema },
        };
  });
  const wireMessages: Record<string, unknown>[] = [];
  for (const message of messages) {
    const row = wire(message, anthropic),
      last = wireMessages.at(-1);
    if (
      anthropic &&
      message.role === "toolResult" &&
      last?.role === "user" &&
      Array.isArray(last.content) &&
      last.content[0]?.type === "tool_result"
    )
      last.content.push(...(row.content as unknown[]));
    else wireMessages.push(row);
  }
  const payload = {
    ...m.defaultConfig,
    model: m.upstreamModel,
    max_tokens: output,
    stream: false,
    ...(anthropic ? { system } : {}),
    tools: defs,
    messages: [
      ...(anthropic ? [] : [{ role: "system", content: system }]),
      ...wireMessages,
    ],
  };
  const estimate = JSON.stringify(payload, (key, value) =>
    (key === "data" || key === "url") &&
    typeof value === "string" &&
    value.length > 2000
      ? "[image]"
      : value,
  );
  const imageCount = messages.flatMap((msg) =>
    typeof msg.content === "string"
      ? []
      : msg.content.filter((c) => c.type === "image"),
  ).length;
  if (tokens(estimate) + 4096 * imageCount + output + 128 > m.maxContext)
    throw new ModelError(422, "Agent 消息超过模型上下文预算");
  const url = new URL(m.baseUrl);
  url.pathname =
    url.pathname.replace(/\/$/, "") +
    (anthropic ? "/messages" : "/chat/completions");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (anthropic)
    Object.assign(headers, {
      "x-api-key": conn.apiKey,
      "anthropic-version": "2023-06-01",
    });
  else headers.Authorization = "Bearer " + conn.apiKey;
  const raw = decode(
    await transport(
      url,
      "POST",
      headers,
      Buffer.from(JSON.stringify(payload)),
      60000,
      signal,
    ),
  );
  try {
    return parseReply(raw, conn);
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(502, "模型工具协议响应无效");
  }
}
