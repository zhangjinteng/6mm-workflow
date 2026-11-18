export class ModelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Restrict credential-bearing management endpoints to local same-origin requests. */
export function assertLocalRequest(request: Request) {
  let url: URL;
  try { url = new URL(`${new URL(request.url).protocol}//${request.headers.get("host") || new URL(request.url).host}`); }
  catch { throw new ModelError(403, "仅允许本地访问"); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new ModelError(403, "仅允许本地访问");
  if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) throw new ModelError(403, "不允许跨域访问");
  if (["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") || "")) throw new ModelError(403, "不允许跨站访问");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && forwardedHost !== url.host) throw new ModelError(403, "不允许代理访问");
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && !forwarded.split(",").every(v => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(v.trim()))) throw new ModelError(403, "不允许远程代理访问");
}

export async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ModelError(415, "请使用 application/json");
  if (Number(request.headers.get("content-length")) > 65536) throw new ModelError(413, "请求体不能超过64KiB");
  if (!request.body) throw new ModelError(400, "请求体不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); throw new ModelError(413, "请求体不能超过64KiB"); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ModelError(400, "JSON 格式错误"); }
  } finally { reader.releaseLock(); }
}

