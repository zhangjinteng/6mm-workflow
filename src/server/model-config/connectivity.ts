import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { request } from "node:https";
import type { ModelInput } from "../../lib/model-config";
import { ModelError } from "./security";

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 96], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blockedV6.addSubnet(address, prefix, "ipv6");
blockedV6.addAddress("::1", "ipv6");
for (const address of ["192.0.2.0", "198.51.100.0", "203.0.113.0", "192.88.99.0"]) blocked.addSubnet(address, 24, "ipv4");
blockedV6.addSubnet("2002::", 16, "ipv6"); blockedV6.addSubnet("2001::", 23, "ipv6");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicAddress(address: string) { const family = isIP(address); return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6"); }

/** Node's family autoselection requests an array when lookup options contain all=true. */
export function pinnedLookup(address: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

export function connectionError(error: { code?: string; name?: string }) {
  if (error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "ETIMEDOUT") return "连接超时，请检查上游地址与网络";
  if (error.code === "ECONNREFUSED") return "上游拒绝连接，请检查 API 地址";
  if (error.code === "ECONNRESET") return "上游连接被重置，请稍后重试";
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(error.code || "")) return "上游 HTTPS 证书校验失败，请检查 API 地址与证书";
  if (error.code === "ERR_INVALID_IP_ADDRESS") return "测试服务地址解析异常，请检查服务端连接配置";
  return "连接失败，请检查上游地址与网络";
}

/** Validate every DNS answer and pin the HTTPS connection to it to prevent rebinding. */
export async function resolveEndpoint(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new ModelError(400, "测试地址必须为标准 HTTPS 地址（443端口）");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost") || hostname.toLowerCase().endsWith(".local")) throw new ModelError(400, "不允许请求本地或内网地址");
  const answers = await lookup(hostname, { all: true });
  if (!answers.length || answers.some(a => !isPublicAddress(a.address))) throw new ModelError(400, "不允许请求本地、内网或保留地址");
  return { url, address: answers[0] };
}

export function buildProbe(input: Omit<ModelInput, "apiKey">) {
  if (input.type === "stt") throw new ModelError(422, "语音识别测试需要音频文件，当前仅支持保存配置");
  if (input.protocol === "anthropic") return { path: "messages", body: { model: input.upstreamModel, max_tokens: 16, messages: [{ role: "user", content: "Hi" }] } };
  if (input.type === "embedding") return { path: "embeddings", body: { model: input.upstreamModel, input: "Hi" } };
  if (input.type === "rerank") return { path: "rerank", body: { model: input.upstreamModel, query: "Hi", documents: ["Hello"], top_n: 1 } };
  if (input.type === "tts") return { path: "audio/speech", body: { model: input.upstreamModel, input: "Hi", voice: typeof input.defaultConfig.voice === "string" ? input.defaultConfig.voice : "alloy", response_format: "wav" } };
  return { path: "chat/completions", body: { model: input.upstreamModel, max_tokens: 16, stream: false, messages: [{ role: "user", content: "Hi" }] } };
}

/** Never expose provider response bodies, which can echo credentials or sensitive data. */
export async function testConnectivity(input: Omit<ModelInput, "apiKey">, apiKey: string) {
  const probe = buildProbe(input), start = Date.now();
  const { url, address } = await resolveEndpoint(input.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${probe.path}`;
  const payload = JSON.stringify(probe.body);
  const result = await new Promise<{ success: boolean; message: string }>((resolve, reject) => {
    const req = request(url, {
      method: "POST", agent: false, signal: AbortSignal.timeout(20000),
      lookup: pinnedLookup(address),
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
        ...(input.protocol === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${apiKey}` }),
      },
    }, res => {
      let length = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 1024 * 1024) { res.destroy(); reject(new ModelError(502, "上游响应超过大小限制")); } else chunks.push(chunk); });
      res.on("error", () => reject(new ModelError(502, "上游响应中断，请稍后重试")));
      res.on("end", () => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) { resolve({ success: false, message: status === 401 || status === 403 ? "认证失败，请检查 API Key 与模型权限" : status === 429 ? "上游限流或额度不足" : status >= 300 && status < 400 ? "上游返回重定向，已拒绝自动跳转" : `上游返回 HTTP ${status}，请检查模型 ID、地址与请求协议` }); return; }
        if (input.type === "tts") { resolve({ success: length > 0, message: length ? "语音合成请求成功" : "上游返回空内容" }); return; }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const valid = input.protocol === "anthropic" ? Array.isArray(body.content) && body.content.length > 0 : input.type === "embedding" ? Array.isArray(body.data) && Array.isArray(body.data[0]?.embedding) : input.type === "rerank" ? Array.isArray(body.results) : Array.isArray(body.choices) && body.choices.length > 0;
          resolve({ success: valid, message: valid ? "模型连接成功" : "请求已返回，但响应结构与所选协议不匹配" });
        } catch { resolve({ success: false, message: "上游未返回有效的模型 JSON 响应" }); }
      });
    });
    req.on("error", error => reject(new ModelError(502, connectionError(error))));
    req.end(payload);
  });
  return { ...result, latencyMs: Date.now() - start };
}
