import { z } from "zod";

export const chatMessage = z.object({
  role: z.enum(["system", "assistant", "user"]),
  content: z.string(),
});
export type Message = z.infer<typeof chatMessage>;
const budget = z.int().positive().optional();
const common = {
  modelId: z.uuid().optional(),
  budgetTokens: budget,
  maxTokens: budget,
  censor: z.boolean().optional(),
  policyId: z.uuid().optional(),
};
const file = z
  .object({
    fileId: z.uuid(),
    encoding: z.string().max(40).optional(),
    customPdfParse: z.boolean().optional(),
  })
  .strict();
const tool = z
  .object({
    toolName: z.string().min(1).max(256),
    result: z.json(),
  })
  .strict();
const chunk = z
  .object({
    id: z.string().min(1).max(256),
    text: z.string(),
    source: z.string().optional(),
    score: z.number().optional(),
  })
  .strict();
export type Chunk = z.infer<typeof chunk>;
const dataset = z
  .object({
    query: z.string().min(1),
    chunks: z
      .array(chunk)
      .refine(
        (rows) => new Set(rows.map((c) => c.id)).size === rows.length,
        "分块 ID 不可重复",
      ),
  })
  .strict();
const source = z.discriminatedUnion("type", [
  file.extend({ type: z.literal("file") }),
  tool.extend({ type: z.literal("tool") }),
  dataset.extend({ type: z.literal("dataset") }),
]);
export type Source = z.infer<typeof source>;
export const compressionOption = z
  .object({ enabled: z.boolean(), sources: z.array(source).max(32).optional() })
  .strict();
export const compressionSchemas = {
  compressHistory: z
    .object({ ...common, messages: z.array(chatMessage).min(1) })
    .strict(),
  compressFile: file.extend(common),
  compressToolResult: tool.extend({
    ...common,
    currentInputTokens: z.int().nonnegative().default(0),
    toolCount: z.int().positive().default(1),
  }),
  compressDatasetResults: dataset.extend(common),
};
export type CompressionNode = keyof typeof compressionSchemas;
