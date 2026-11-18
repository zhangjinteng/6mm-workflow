import { MongoClient } from "mongodb";
import { decryptLegacyCredential, type LegacySecret } from "./legacy-model-credential";

type LegacyCredential = { _id: string; modelId: string; secret: LegacySecret; apiKey?: string };
const e = process.env;
const apply = process.argv.includes("--apply");
const client = new MongoClient(`mongodb://${e.MONGODB_HOST}:${e.MONGODB_PORT || 27017}`, {
  auth: { username: e.MONGODB_USER || "", password: e.MONGODB_PASSWORD || "" },
  authSource: e.MONGODB_AUTH_SOURCE || e.MONGODB_DATABASE || "workflow",
  serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000, retryWrites: false, tls: e.MONGODB_TLS === "true",
});
try {
  const collection = client.db(e.MONGODB_DATABASE || "workflow").collection<LegacyCredential>("workflow16080_credentials");
  const rows = await collection.find({ secret: { $exists: true } }).toArray();
  // Decrypt and validate every record before writing any of them.
  const changes = rows.map(row => {
    if (typeof row._id !== "string" || typeof row.modelId !== "string") throw new Error("Invalid legacy record");
    const apiKey = decryptLegacyCredential(row.secret, row.modelId, e.MODEL_CREDENTIAL_KEY);
    if (row.apiKey !== undefined && row.apiKey !== apiKey) throw new Error("Credential conflict");
    return { updateOne: {
      filter: { _id: row._id, modelId: row.modelId, secret: row.secret, apiKey: row.apiKey === undefined ? { $exists: false } : row.apiKey },
      update: { $set: { apiKey }, $unset: { secret: "" as const } },
    } };
  });
  if (!apply) console.log(`待迁移凭据：${changes.length}；未修改数据。使用 --apply 执行。`);
  else {
    if (changes.length) {
      const result = await collection.bulkWrite(changes, { ordered: true });
      if (result.matchedCount !== changes.length) throw new Error("Concurrent credential change");
    }
    console.log(`已迁移凭据：${changes.length}；API Key 已写入 apiKey 字段，旧 secret 字段已移除。`);
  }
} catch {
  console.error("凭据迁移失败；请检查数据库连接、原 MODEL_CREDENTIAL_KEY、数据完整性或并发修改。可修正后重跑；日志不会输出凭据。");
  process.exitCode = 1;
} finally { await client.close(); }
