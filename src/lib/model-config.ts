import { z } from "zod";

export const modelTypes = ["llm", "embedding", "rerank", "tts", "stt"] as const;
export type ModelType = (typeof modelTypes)[number];
export const typeNames: Record<ModelType, string> = { llm: "语言模型", embedding: "向量模型", rerank: "重排模型", tts: "语音合成", stt: "语音识别" };
export type Provider = { id: string; name: string; icon?: string; color: string; baseUrl: string; models: string[]; protocol: "openai" | "anthropic"; disabled?: boolean };
export const providers: Provider[] = [
  { id: "custom", name: "自定义模型", color: "#aaaeb8", baseUrl: "", models: [], protocol: "openai" },
  { id: "deepseek", name: "DeepSeek", icon: "deepseek", color: "#657aff", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-flash", "deepseek-v4-pro"], protocol: "openai" },
  { id: "volcengine", name: "火山引擎", icon: "doubao", color: "#37b8db", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [], protocol: "openai" },
  { id: "minimax-cn", name: "MiniMax CN", icon: "minimax", color: "#ea637f", baseUrl: "https://api.minimaxi.com/v1", models: [], protocol: "openai" },
  { id: "minimax", name: "MiniMax Global", icon: "minimax", color: "#ea637f", baseUrl: "https://api.minimax.io/v1", models: [], protocol: "openai" },
  { id: "zhipu", name: "Bigmodel", icon: "chatglm", color: "#83a3ff", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: [], protocol: "openai" },
  { id: "aliyun", name: "阿里云", icon: "qwen", color: "#ef9c68", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: [], protocol: "openai" },
  { id: "siliconflow", name: "硅基流动", icon: "siliconflow", color: "#9b8ce8", baseUrl: "https://api.siliconflow.cn/v1", models: [], protocol: "openai" },
  { id: "zai", name: "Z.ai", icon: "chatglm", color: "#83a3ff", baseUrl: "https://api.z.ai/api/paas/v4", models: [], protocol: "openai" },
  { id: "openrouter", name: "OpenRouter", icon: "openrouter", color: "#9b8ce8", baseUrl: "https://openrouter.ai/api/v1", models: [], protocol: "openai" },
  { id: "moonshot-cn", name: "Kimi CN", icon: "moonshot", color: "#b9c9ee", baseUrl: "https://api.moonshot.cn/v1", models: [], protocol: "openai" },
  { id: "moonshot", name: "Kimi Global", icon: "moonshot", color: "#b9c9ee", baseUrl: "https://api.moonshot.ai/v1", models: [], protocol: "openai" },
  { id: "byteplus", name: "BytePlus", icon: "doubao", color: "#37b8db", baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3", models: [], protocol: "openai" },
  { id: "openai", name: "OpenAI", icon: "openai", color: "#6dc9af", baseUrl: "https://api.openai.com/v1", models: [], protocol: "openai" },
  { id: "anthropic", name: "Anthropic", icon: "anthropic", color: "#d2a17e", baseUrl: "https://api.anthropic.com/v1", models: [], protocol: "anthropic" },
  { id: "hunyuan", name: "腾讯混元", icon: "hunyuan", color: "#5ca4f0", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", models: [], protocol: "openai" },
];
export const providerById = (id: string) => providers.find(p => p.id === id);

const safeJson = z.unknown().superRefine((value, ctx) => {
  function check(item: unknown, depth: number) {
    if (depth > 10) { ctx.addIssue({ code: "custom", message: "参数嵌套不能超过10层" }); return; }
    if (item && typeof item === "object") for (const [key, v] of Object.entries(item)) {
      if (key.startsWith("$") || key.includes(".") || ["__proto__", "constructor", "prototype"].includes(key)) ctx.addIssue({ code: "custom", message: "参数包含不允许的字段名" });
      if (["apikey", "api_key", "authorization", "requestauth", "password"].includes(key.toLowerCase())) ctx.addIssue({ code: "custom", message: "密钥不能放在默认请求参数中，请使用 API Key 字段" });
      check(v, depth + 1);
    }
  }
  check(value, 0);
}).pipe(z.record(z.string(), z.json())).default({});
export const modelInputSchema = z.object({
  providerId: z.string().refine(v => !!providerById(v), "请选择服务商"),
  upstreamModel: z.string().trim().min(1, "请输入 Model ID").max(256).regex(/^[^\s\x00-\x1f]+$/, "Model ID 不能包含空白字符"),
  name: z.string().trim().max(64, "展示名称最多64个字符").default(""),
  type: z.enum(modelTypes).default("llm"),
  protocol: z.enum(["openai", "anthropic"]).default("openai"),
  baseUrl: z.string().trim().url("请输入有效的 HTTPS 地址").max(1000).refine(v => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; }, "地址必须使用 HTTPS，且不能包含用户名、密码、查询参数或片段"),
  apiKey: z.string().trim().max(8192).regex(/^[^\r\n]*$/, "API Key 格式错误").optional(),
  isActive: z.boolean().default(true),
  maxContext: z.number().int().min(1).max(10000000).default(128000),
  maxResponse: z.number().int().min(1).max(1000000).default(4096),
  quoteMaxToken: z.number().int().min(0).max(1000000).default(10000),
  capabilities: z.array(z.enum(["vision", "audio", "video", "reasoning", "functionCall", "toolChoice"])).max(6).default([]),
  defaultConfig: safeJson,
}).strict().superRefine((value, ctx) => {
  if (value.protocol === "anthropic" && value.type !== "llm") ctx.addIssue({ code: "custom", path: ["type"], message: "Anthropic 协议目前仅支持语言模型" });
  if (value.maxResponse > value.maxContext) ctx.addIssue({ code: "custom", path: ["maxResponse"], message: "最大输出不能超过上下文长度" });
});
export type ModelInput = z.infer<typeof modelInputSchema>;
export type ModelView = Omit<ModelInput, "apiKey"> & { id: string; model: string; revision: number; isDefault: boolean; hasCredential: boolean; deletedAt?: string; createdAt: string; updatedAt: string; lastTest?: { success: boolean; latencyMs: number; message: string; testedAt: string } };
export type ModelList = { models: ModelView[]; database: { connected: boolean; name: string; message?: string } };
