import { z } from "zod";
import { assertLocalRequest, ModelError } from "../model-config/security";

export { ModelError };
export const fileId = z.string().uuid();
export const uploadLimit = 24 * 1024 * 1024;

export async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit)
    throw new ModelError(413, "请求过大");
  const reader = request.body?.getReader();
  if (!reader) throw new ModelError(400, "缺少请求体");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ModelError(413, "请求过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ModelError(415, "请使用 application/json");
  const bytes = await boundedBody(request, 1024 * 1024);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ModelError(400, "JSON 无效");
  }
}
export async function local(request: Request, action: () => Promise<Response>) {
  try {
    assertLocalRequest(request);
    const response = await action();
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch (error) {
    const status =
      error instanceof ModelError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    const message =
      error instanceof ModelError
        ? error.message
        : error instanceof z.ZodError
          ? "参数错误: " + error.issues.map((i) => i.path.join(".")).join(", ")
          : "操作失败";
    return Response.json(
      { code: status, error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
