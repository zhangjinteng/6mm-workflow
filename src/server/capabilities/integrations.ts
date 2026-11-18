import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database } from "../model-config/repository";
import { ModelError } from "./base";

export const kinds = z.enum(["customPdf", "textin", "doc2x", "moderation"]);
export const integrationSchema = z
  .object({
    kind: kinds,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    url: z.url().optional(),
    key: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[^\r\n]+$/)
      .optional(),
    appId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n]+$/)
      .optional(),
    blockedTerms: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.url) {
      const endpoint = URL.canParse(c.url) ? new URL(c.url) : null;
      if (
        !endpoint ||
        endpoint.protocol !== "https:" ||
        (endpoint.port && endpoint.port !== "443") ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        ctx.addIssue({ code: "custom", message: "需要标准 HTTPS 服务地址" });
    }
    if (
      (c.kind === "customPdf" && !c.url) ||
      (c.kind === "moderation" && !c.url && !c.blockedTerms?.length) ||
      (c.kind === "textin" && (!c.appId || !c.key)) ||
      (c.kind === "doc2x" && !c.key)
    )
      ctx.addIssue({ code: "custom", message: "缺少连接必需配置" });
  });
type Config = z.infer<typeof integrationSchema>;
type RecordType = Config & { _id: string; revision?: number };
const collection = async () =>
  (await database()).collection<RecordType>("workflow16080_integrations");
function view(c: RecordType) {
  const { key, _id, ...publicFields } = c;
  return { ...publicFields, id: _id, hasCredential: Boolean(key) };
}
export async function listIntegrations() {
  return (await (await collection()).find().toArray()).map(view);
}
export async function createIntegration(data: unknown) {
  const row = {
    ...integrationSchema.parse(data),
    _id: randomUUID(),
    revision: 1,
  };
  await (await collection()).insertOne(row);
  return view(row);
}
export async function byId(id: string) {
  const row = await (await collection()).findOne({ _id: z.uuid().parse(id) });
  if (!row) throw new ModelError(404, "服务配置不存在");
  return row;
}
export async function manageIntegration(
  id: string,
  method: string,
  data?: unknown,
) {
  const row = await byId(id);
  if (method === "GET") return view(row);
  const col = await collection();
  if (method === "DELETE") {
    await col.deleteOne({ _id: id });
    return { deleted: true };
  }
  const { _id, revision, ...config } = row;
  const patch = z.record(z.string(), z.unknown()).parse(data);
  const next = integrationSchema.parse({ ...config, ...patch });
  if (next.kind !== row.kind) throw new ModelError(409, "连接类型不能更改");
  const nextRow = { ...next, _id, revision: (revision ?? 0) + 1 };
  const saved = await col.replaceOne(
    { _id, revision: revision ?? { $exists: false } },
    nextRow,
  );
  if (!saved.modifiedCount) throw new ModelError(409, "配置已变更，请重新读取");
  return view(nextRow);
}
export async function resolveIntegration(
  kind: Config["kind"],
  id?: string,
  optional = false,
) {
  const row = id
    ? await byId(id)
    : await (await collection())
        .find({ kind, enabled: true })
        .sort({ _id: 1 })
        .limit(1)
        .next();
  if (row?.kind === kind && row.enabled) return row;
  if (optional && !id) return null;
  throw new ModelError(503, "缺少可用的 " + kind + " 服务配置");
}
