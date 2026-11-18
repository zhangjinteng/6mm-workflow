import { MongoClient, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import type { ModelInput, ModelView, ModelType } from "../../lib/model-config";
import { ModelError } from "./security";

type ModelRecord = { _id: string; model: string; metadata: Omit<ModelInput, "apiKey">; credentialId?: string; revision: number; createdAt: Date; updatedAt: Date; deletedAt?: Date; lastTest?: { success: boolean; latencyMs: number; message: string; testedAt: Date } };
type Credential = { _id: string; modelId: string; apiKey: string; createdAt: Date };
type Settings = { _id: string; defaults: Partial<Record<ModelType, string>> };
const globals = globalThis as typeof globalThis & { modelDb?: Promise<Db>; modelWrites?: Promise<unknown> };

/** Use a single pool and create only this feature's namespaced collections/indexes. */
export function database(): Promise<Db> {
  if (!globals.modelDb) globals.modelDb = (async () => {
    const e = process.env;
    if (!e.MONGODB_HOST || !e.MONGODB_USER || !e.MONGODB_PASSWORD) throw new ModelError(503, "MongoDB 连接尚未配置");
    const client = new MongoClient(`mongodb://${e.MONGODB_HOST}:${e.MONGODB_PORT || 27017}`, {
      auth: { username: e.MONGODB_USER, password: e.MONGODB_PASSWORD }, authSource: e.MONGODB_AUTH_SOURCE || e.MONGODB_DATABASE || "workflow",
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000, maxPoolSize: 5, retryWrites: false,
      tls: e.MONGODB_TLS === "true",
    });
    try {
      await client.connect(); const db = client.db(e.MONGODB_DATABASE || "workflow");
      await db.collection<ModelRecord>("workflow16080_models").createIndexes([
        { key: { model: 1 }, unique: true, name: "model_identity" },
        { key: { "metadata.type": 1, "metadata.isActive": 1, deletedAt: 1 }, name: "model_filter" },
      ]);
      await db.collection<Credential>("workflow16080_credentials").createIndex({ modelId: 1 });
      return db;
    } catch (error) { await client.close(); globals.modelDb = undefined; throw error; }
  })();
  return globals.modelDb;
}

/** Serialize local-instance edits; defaults are stored as one atomic settings document. */
export async function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = (globals.modelWrites || Promise.resolve()).then(action, action);
  globals.modelWrites = result.catch(() => {}); return result;
}
const models = (db: Db) => db.collection<ModelRecord>("workflow16080_models");
const credentials = (db: Db) => db.collection<Credential>("workflow16080_credentials");
const settings = (db: Db) => db.collection<Settings>("workflow16080_settings");
function view(row: ModelRecord, defaults: Settings["defaults"]): ModelView {
  return { ...row.metadata, id: row._id, model: row.model, revision: row.revision, isDefault: !row.deletedAt && row.metadata.isActive && defaults[row.metadata.type] === row._id,
    hasCredential: !!row.credentialId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    ...(row.lastTest ? { lastTest: { ...row.lastTest, testedAt: row.lastTest.testedAt.toISOString() } } : {}),
  };
}
export async function listModels() {
  const db = await database(); const rows = await models(db).find({}).sort({ createdAt: -1 }).limit(1000).toArray();
  const config = await settings(db).findOne({ _id: "defaults" });
  return { models: rows.map(row => view(row, config?.defaults || {})), database: { connected: true, name: db.databaseName } };
}
export async function saveModel(input: ModelInput, id?: string, revision?: number) {
  return serialize(async () => {
    const db = await database(), col = models(db), modelId = id || randomUUID();
    const old = id ? await col.findOne({ _id: id, deletedAt: { $exists: false } }) : null;
    if (id && !old) throw new ModelError(404, "模型不存在或已移入回收站");
    if (old && old.revision !== revision) throw new ModelError(409, "配置已被修改，请刷新后重试");
    if (old && old.metadata.type !== input.type) throw new ModelError(409, "模型类型创建后不能修改，请添加新的模型配置");
    const config = await settings(db).findOne({ _id: "defaults" });
    if (old && Object.values(config?.defaults || {}).includes(modelId) && (!input.isActive || input.type !== old.metadata.type)) throw new ModelError(409, "请先更换默认模型，再停用或更改类型");
    const { apiKey, ...metadata } = input;
    metadata.name ||= metadata.upstreamModel;
    let credentialId = old?.credentialId;
    if (apiKey) {
      credentialId = randomUUID();
      await credentials(db).insertOne({ _id: credentialId, modelId, apiKey, createdAt: new Date() });
    }
    if (!credentialId) throw new ModelError(400, "请填写 API Key");
    const now = new Date();
    try {
      if (old) {
        const updated = await col.updateOne({ _id: modelId, revision: old.revision }, { $set: { metadata, credentialId, updatedAt: now }, $unset: { lastTest: "" }, $inc: { revision: 1 } });
        if (!updated.modifiedCount) throw new ModelError(409, "配置已被修改，请刷新后重试");
      } else await col.insertOne({ _id: modelId, model: `local_${modelId}`, metadata, credentialId, revision: 1, createdAt: now, updatedAt: now });
    } catch (error) { if (credentialId !== old?.credentialId) await credentials(db).deleteOne({ _id: credentialId }); throw error; }
    return { id: modelId };
  });
}
export async function changeModel(id: string, revision: number, action: "enable" | "disable" | "default" | "unsetDefault" | "delete" | "restore") {
  return serialize(async () => {
    const db = await database(), col = models(db), row = await col.findOne({ _id: id });
    if (!row) throw new ModelError(404, "模型不存在");
    if (row.revision !== revision) throw new ModelError(409, "配置已被修改，请刷新后重试");
    const config = await settings(db).findOne({ _id: "defaults" });
    if (row.deletedAt && action !== "restore") throw new ModelError(409, "请先从回收站恢复模型");
    if (action === "unsetDefault") {
      await settings(db).updateOne({ _id: "defaults", [`defaults.${row.metadata.type}`]: id }, { $unset: { [`defaults.${row.metadata.type}`]: "" } });
      return;
    }
    if (["disable", "delete"].includes(action) && Object.values(config?.defaults || {}).includes(id)) throw new ModelError(409, "默认模型不能停用或删除，请先更换默认模型");
    if (action === "default") {
      if (!row.metadata.isActive) throw new ModelError(409, "请先启用模型");
      await settings(db).updateOne({ _id: "defaults" }, { $set: { [`defaults.${row.metadata.type}`]: id } }, { upsert: true });
      return;
    }
    const updated = await col.updateOne({ _id: id, revision }, {
      $set: { updatedAt: new Date(), ...(action === "delete" ? { deletedAt: new Date() } : {}), ...(["enable", "disable", "restore"].includes(action) ? { "metadata.isActive": action === "enable" } : {}) },
      ...(action === "restore" ? { $unset: { deletedAt: "" } } : {}), $inc: { revision: 1 },
    });
    if (!updated.modifiedCount) throw new ModelError(409, "配置已被修改，请刷新后重试");
  });
}
export async function getTestTarget(id: string) {
  const db = await database(), row = await models(db).findOne({ _id: id, deletedAt: { $exists: false } });
  if (!row) throw new ModelError(404, "模型不存在");
  const credential = row.credentialId ? await credentials(db).findOne({ _id: row.credentialId, modelId: id }) : null;
  if (!credential || typeof credential.apiKey !== "string" || !credential.apiKey.trim()) throw new ModelError(409, "模型没有可用明文凭据，请迁移旧凭据或重新填写 API Key");
  return { input: row.metadata, apiKey: credential.apiKey, revision: row.revision };
}
export async function recordTest(id: string, revision: number, result: { success: boolean; latencyMs: number; message: string }) {
  const db = await database(); await models(db).updateOne({ _id: id, revision, deletedAt: { $exists: false } }, { $set: { lastTest: { ...result, testedAt: new Date() } } });
}
