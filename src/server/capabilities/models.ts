import { z } from "zod";
import { getTestTarget, database } from "../model-config/repository";
import type { ModelType } from "../../lib/model-config";
import { getFile, saveFile } from "./files";
import { send, decode, multipart } from "./network";
import { ModelError } from "./base";
const id = z.uuid().optional();
const input = z.string().min(1);
const messages = z
  .array(
    z.object({
      role: z.enum(["system", "assistant", "user"]),
      content: z.string(),
    }),
  )
  .min(1);
export const modelSchemas = {
  modelChat: z
    .object({
      modelId: id,
      messages,
      censor: z.boolean().optional(),
      policyId: id,
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .strict(),
  modelEmbed: z
    .object({ modelId: id, input: z.union([input, z.array(input).min(1)]) })
    .strict(),
  modelRerank: z
    .object({
      modelId: id,
      query: input,
      documents: z.array(input).min(1),
      topN: z.number().int().positive().optional(),
    })
    .strict(),
  modelTts: z.object({ modelId: id, input, voice: input.optional() }).strict(),
  modelStt: z
    .object({ modelId: id, fileId: z.uuid(), language: z.string().optional() })
    .strict(),
};
export const types = {
  modelChat: "llm",
  modelEmbed: "embedding",
  modelRerank: "rerank",
  modelTts: "tts",
  modelStt: "stt",
} as const;
async function target(type: ModelType, id?: string) {
  if (!id) {
    const db = await database();
    const row = await db
      .collection<{
        _id: string;
        defaults: Partial<Record<ModelType, string>>;
      }>("workflow16080_settings")
      .findOne({ _id: "defaults" });
    id = row?.defaults[type];
  }
  if (!id) throw new ModelError(503, "请指定 modelId 或设置默认模型");
  const model = await getTestTarget(id);
  if (!model.input.isActive || model.input.type !== type)
    throw new ModelError(409, "模型未启用或类型不匹配");
  return model;
}
export async function callModel(
  name: keyof typeof types,
  params: unknown,
  load = target,
  transport = send,
) {
  const modelId = z.object({ modelId: id }).parse(params).modelId;
  const { input: model, apiKey } = await load(types[name], modelId);
  const anthropic = model.protocol === "anthropic";
  let endpoint = "";
  const json: Record<string, unknown> = {
    ...model.defaultConfig,
    model: model.upstreamModel,
  };
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: "Bearer " + apiKey };
  headers["Content-Type"] = "application/json";
  let body: Buffer | undefined;
  switch (name) {
    case "modelChat": {
      const p = modelSchemas.modelChat.parse(params);
      endpoint = anthropic ? "messages" : "chat/completions";
      json.messages = anthropic
        ? p.messages.filter((m) => m.role !== "system")
        : p.messages;
      if (anthropic) {
        const system = p.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n");
        if (system) json.system = system;
      }
      json.stream = false;
      json.max_tokens = Math.min(
        p.maxTokens || model.maxResponse,
        model.maxResponse,
      );
      if (p.temperature !== undefined) json.temperature = p.temperature;
      break;
    }
    case "modelEmbed":
      endpoint = "embeddings";
      json.input = modelSchemas.modelEmbed.parse(params).input;
      break;
    case "modelRerank": {
      const p = modelSchemas.modelRerank.parse(params);
      endpoint = "rerank";
      Object.assign(json, {
        documents: p.documents,
        query: p.query,
        top_n: p.topN,
      });
      break;
    }
    case "modelTts": {
      const p = modelSchemas.modelTts.parse(params);
      endpoint = "audio/speech";
      Object.assign(json, {
        input: p.input,
        voice: p.voice || json.voice || "alloy",
        response_format: "mp3",
      });
      break;
    }
    case "modelStt": {
      const p = modelSchemas.modelStt.parse(params);
      endpoint = "audio/transcriptions";
      const f = await getFile(p.fileId);
      const form = await multipart(
        {
          model: model.upstreamModel,
          ...(p.language ? { language: p.language } : {}),
        },
        "file",
        await f.bytes(),
        f.meta.name,
        f.meta.mime,
      );
      headers["Content-Type"] = form.type;
      body = form.body;
      break;
    }
  }
  const url = new URL(model.baseUrl);
  url.pathname = url.pathname.replace(/\/$/, "") + "/" + endpoint;
  const bytes = await transport(
    url,
    "POST",
    headers,
    body || Buffer.from(JSON.stringify(json)),
  );
  if (name === "modelTts") {
    if (
      bytes.subarray(0, 3).toString() !== "ID3" &&
      !(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    )
      throw new ModelError(502, "上游未返回 MP3 音频");
    return { file: await saveFile(bytes, "speech.mp3", "audio/mpeg") };
  }
  const result = decode(bytes);
  const schema =
    name === "modelChat"
      ? anthropic
        ? z.object({
            content: z
              .array(z.object({ type: z.string() }).passthrough())
              .min(1),
          })
        : z.object({
            choices: z
              .array(
                z
                  .object({
                    message: z
                      .object({ content: z.string().nullable() })
                      .passthrough(),
                  })
                  .passthrough(),
              )
              .min(1),
          })
      : name === "modelEmbed"
        ? z.object({
            data: z
              .array(
                z
                  .object({ embedding: z.array(z.number()).min(1) })
                  .passthrough(),
              )
              .min(1),
          })
        : name === "modelRerank"
          ? z.object({
              results: z.array(
                z
                  .object({
                    index: z.number().int(),
                    relevance_score: z.number(),
                  })
                  .passthrough(),
              ),
            })
          : z.object({ text: z.string() });
  if (!schema.passthrough().safeParse(result).success)
    throw new ModelError(502, "模型响应结构与协议不匹配");
  return result;
}
