import { z, ZodError } from "zod";
import { modelInputSchema } from "../../lib/model-config";
import { assertLocalRequest, ModelError, readJson } from "./security";
import { changeModel, getTestTarget, listModels, recordTest, saveModel } from "./repository";
import { testConnectivity } from "./connectivity";

const identity = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const action = identity.extend({ action: z.enum(["enable", "disable", "default", "unsetDefault", "delete", "restore"]) });
const cacheHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
/** All errors are curated; never serialize driver exceptions, credentials or raw request data. */
export function modelRoute(handler: (request: Request) => Promise<unknown>) {
  return async (request: Request) => {
    try { assertLocalRequest(request); return Response.json({ data: await handler(request) }, { headers: cacheHeaders }); }
    catch (error) {
      const status = error instanceof ModelError ? error.status : error instanceof ZodError ? 400 : 503;
      const message = error instanceof ModelError ? error.message : error instanceof ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("；") : "MongoDB 暂不可用，请检查连接地址、认证库、账号权限和网络";
      return Response.json({ error: message }, { status, headers: cacheHeaders });
    }
  };
}
export const GET = modelRoute(async () => listModels());
export const POST = modelRoute(async request => saveModel(modelInputSchema.parse(await readJson(request))));
export const PUT = modelRoute(async request => {
  const body = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), input: modelInputSchema }).strict().parse(await readJson(request));
  return saveModel(body.input, body.id, body.revision);
});
export const PATCH = modelRoute(async request => { const body = action.parse(await readJson(request)); await changeModel(body.id, body.revision, body.action); return { success: true }; });
const activeTests = new Set<string>();
const lastTests = new Map<string, number>();
export const TEST = modelRoute(async request => {
  const body = identity.extend({ confirmed: z.literal(true) }).parse(await readJson(request));
  if (activeTests.has(body.id) || Date.now() - (lastTests.get(body.id) || 0) < 10000 || activeTests.size >= 3) throw new ModelError(429, "测试过于频繁，请稍后重试");
  activeTests.add(body.id); lastTests.set(body.id, Date.now());
  try {
    const target = await getTestTarget(body.id);
    if (body.revision !== target.revision) throw new ModelError(409, "配置已修改，请刷新后重试");
    let result;
    try { result = await testConnectivity(target.input, target.apiKey); }
    catch (error) { result = { success: false, latencyMs: 0, message: error instanceof ModelError ? error.message : "无法解析或连接上游地址" }; }
    await recordTest(body.id, target.revision, result); return result;
  } finally { activeTests.delete(body.id); for (const [id, time] of lastTests) if (Date.now() - time > 60000) lastTests.delete(id); }
});
