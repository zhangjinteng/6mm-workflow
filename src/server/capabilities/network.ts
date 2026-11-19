import { request } from "node:https";
import { pinnedLookup, resolveEndpoint } from "../model-config/connectivity";
import { ModelError } from "./base";

/** Pin every upstream connection to the validated DNS result, including signed upload URLs. */
export async function send(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
  timeout = 60000,
  signal?: AbortSignal,
) {
  const { address } = await resolveEndpoint(url.origin).catch((error) => {
    if (error instanceof ModelError) throw error;
    throw new ModelError(502, "上游地址解析失败");
  });
  if (url.username || url.password) throw new ModelError(400, "地址含非法凭据");
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers,
        agent: false,
        lookup: pinnedLookup(address),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) res.destroy(new Error("size"));
          else chunks.push(chunk);
        });
        res.on("error", () =>
          reject(new ModelError(502, "上游响应中断或过大")),
        );
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)
            reject(new ModelError(502, "上游 HTTP " + res.statusCode));
          else resolve(Buffer.concat(chunks));
        });
      },
    );
    req.on("error", (e) =>
      reject(
        new ModelError(
          e.name === "AbortError" ? 504 : 502,
          "上游连接失败或超时",
        ),
      ),
    );
    req.end(body);
  });
}
export function decode(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString());
  } catch {
    throw new ModelError(502, "上游响应不是 JSON");
  }
}
export async function multipart(
  fields: Record<string, string>,
  field: string,
  bytes: Buffer,
  name: string,
  mime: string,
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(field, new Blob([new Uint8Array(bytes)], { type: mime }), name);
  const encoded = new Response(form);
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    type: encoded.headers.get("content-type")!,
  };
}
