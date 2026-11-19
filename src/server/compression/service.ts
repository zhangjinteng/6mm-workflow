import { z } from "zod";
import { ModelError } from "../capabilities/base";
import { readCompressionFile } from "../capabilities/documents";
import {
  callModel,
  chatPayload,
  target,
  type ChatInput,
} from "../capabilities/models";
import {
  Compression,
  tokens,
  datasetText,
  protectedMessages,
  insertContext,
} from "./engine";
import {
  compressionSchemas,
  type Source,
  type Message,
  type CompressionNode,
} from "./schema";

const reply = z.union([
  z
    .object({
      choices: z
        .array(z.object({ message: z.object({ content: z.string() }) }))
        .min(1),
    })
    .transform((v) => v.choices[0].message.content),
  z
    .object({
      content: z.array(
        z.object({ type: z.string(), text: z.string().optional() }),
      ),
    })
    .transform((v) =>
      v.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    ),
]);
export async function openCompression(
  modelId?: string,
  maxTokens?: number,
  usages: unknown[] = [],
  temperature?: number,
) {
  // Pin both budget and credentials to one model revision for the entire request.
  const selected = await target("llm", modelId);
  const model = selected.input;
  const chat = (p: ChatInput) =>
    callModel("modelChat", p, async () => selected);
  const engine = new Compression(
    {
      maxContext: model.maxContext,
      maxResponse: model.maxResponse,
      measure: (messages, output) =>
        tokens(
          JSON.stringify(
            chatPayload(model, {
              messages,
              maxTokens: output ?? maxTokens,
              temperature: output === undefined ? temperature : 0,
            }),
          ),
        ),
      ask: async (messages, output) => {
        const raw = await chat({ messages, maxTokens: output, temperature: 0 });
        if (raw && typeof raw === "object" && "usage" in raw)
          usages.push(raw.usage);
        return reply.parse(raw);
      },
    },
    maxTokens,
  );
  return { engine, chat };
}

type Review = (text: string) => Promise<void>;
type Material = Awaited<ReturnType<typeof readMaterial>>;
async function readMaterial(source: Source) {
  if (source.type === "dataset")
    return {
      type: source.type,
      label: "知识库检索 " + source.query,
      raw: datasetText(source.chunks),
      source,
    };
  if (source.type === "tool")
    return {
      type: source.type,
      label: "工具 " + source.toolName,
      raw:
        typeof source.result === "string"
          ? source.result
          : JSON.stringify(source.result),
      source,
    };
  const file = await readCompressionFile(source);
  return {
    type: source.type,
    label: "文件 " + file.filename,
    raw: file.text,
    filename: file.filename,
    source,
  };
}
const evidence = (label: string, text: string): Message => ({
  role: "user",
  content: "参考资料（" + label + "）\n" + text,
});
async function compressMaterial(
  engine: Compression,
  material: Material,
  cap: number,
) {
  if (material.type === "dataset") {
    const { chunks, selectedIds, ...stats } = await engine.dataset(
      material.source.query,
      material.source.chunks,
      cap,
    );
    return {
      content: datasetText(chunks),
      result: { chunks, selectedIds, ...stats },
      stats: { selectedIds, ...stats },
    };
  }
  const { text, ...stats } = await engine.text(
    material.raw,
    Math.min(cap, engine.contentBudget()),
  );
  const identity =
    material.type === "file"
      ? { fileId: material.source.fileId, filename: material.filename }
      : { toolName: material.source.toolName };
  return {
    content: text,
    result: { ...identity, text, ...stats },
    stats: { ...identity, ...stats },
  };
}

export async function compressionNode(
  name: CompressionNode,
  input: unknown,
  review?: Review,
  usages: unknown[] = [],
) {
  const p = compressionSchemas[name].parse(input);
  const { engine } = await openCompression(p.modelId, p.maxTokens, usages);
  if ("messages" in p) {
    await review?.(p.messages.map((m) => m.content).join("\n"));
    return engine.history(p.messages, p.budgetTokens);
  }
  const material =
    "fileId" in p
      ? await readMaterial({ type: "file", ...p })
      : "toolName" in p
        ? await readMaterial({ type: "tool", ...p })
        : await readMaterial({ type: "dataset", ...p });
  await review?.(material.label + "\n" + material.raw);
  const cap =
    "toolCount" in p
      ? engine.contentBudget(p.currentInputTokens, p.toolCount, p.budgetTokens)
      : Math.min(engine.budget, p.budgetTokens ?? Infinity);
  return (await compressMaterial(engine, material, cap)).result;
}

export async function prepareChat(
  chat: ChatInput,
  engine: Compression,
  review?: Review,
) {
  const materials: Material[] = [];
  for (const source of chat.compression?.sources ?? [])
    materials.push(await readMaterial(source));
  const messages = chat.messages;
  // Review all original inputs before the first ranking, summary or answer model call.
  await review?.(
    [
      ...messages.map((m) => m.content),
      ...materials.map((m) => m.label + "\n" + m.raw),
    ].join("\n"),
  );
  const measure = engine.runtime.measure;
  const assembled = (history: Message[], bodies: string[]) =>
    insertContext(
      history,
      bodies.map((s, i) => evidence(materials[i].label, s)),
    );
  const before = measure(
    assembled(
      messages,
      materials.map((m) => m.raw),
    ),
  );
  const { fixed, old } = protectedMessages(messages);
  const fixedCost = measure(
    assembled(
      fixed,
      materials.map(() => ""),
    ),
  );
  if (fixedCost > engine.budget)
    throw new ModelError(
      422,
      "系统指令、当前问题及来源标识超出输入预算 " +
        (fixedCost - engine.budget) +
        " Token",
    );

  // Share remaining space fairly. A small source releases its unused share to the larger ones.
  const needs = materials.map((m) => tokens(m.raw));
  if (old.length) needs.push(Math.max(0, measure(messages) - measure(fixed)));
  let remaining = Math.max(0, engine.budget - fixedCost);
  const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
  const grants = needs.slice();
  order.forEach((i, index) => {
    grants[i] = Math.min(
      needs[i],
      Math.floor(remaining / (order.length - index)),
    );
    remaining -= grants[i];
  });
  const bodies: string[] = [];
  const sources = [];
  for (const [i, material] of materials.entries()) {
    const compressed = await compressMaterial(engine, material, grants[i]);
    bodies.push(compressed.content);
    sources.push({ type: material.type, ...compressed.stats });
  }
  const overhead = measure(assembled(fixed, bodies)) - measure(fixed);
  const history = await engine.history(
    messages,
    Math.min(engine.budget, engine.budget - overhead),
    old.length > 0 &&
      measure(assembled(messages, bodies)) >=
        Math.floor(engine.runtime.maxContext * 0.8),
  );
  const next = assembled(history.messages, bodies);
  const after = measure(next);
  if (after > engine.budget)
    throw new ModelError(
      422,
      "最终输入超出预算 " + (after - engine.budget) + " Token",
    );
  const {
    checkpoint,
    strategy,
    modelCalls,
    tokensBefore,
    tokensAfter,
    budgetTokens,
    warnings,
  } = history;
  const historyStats = {
    strategy,
    modelCalls,
    tokensBefore,
    tokensAfter,
    budgetTokens,
    warnings,
  };
  return {
    messages: next,
    compression: {
      tokensBefore: before,
      tokensAfter: after,
      budgetTokens: engine.budget,
      checkpoint,
      modelCalls: engine.calls,
      history: historyStats,
      sources,
      warnings: [...history.warnings, ...sources.flatMap((s) => s.warnings)],
    },
  };
}
