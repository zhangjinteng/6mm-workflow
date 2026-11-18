import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const base = process.env.MODEL_API_BASE_URL || "http://127.0.0.1:16080";
const marker = `smoke-${randomUUID()}`;
const key = `disposable-not-a-real-api-key-${randomUUID()}`;
const input = { providerId: "custom", upstreamModel: marker, name: "配置接口临时验收", type: "llm", protocol: "openai", baseUrl: "https://127.0.0.1/v1", apiKey: key, isActive: true };
const ids = [];
async function call(method, path, body, expected = 200) {
  const response = await fetch(`${base}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); assert(!text.includes(key), "credential exposed in response");
  assert.equal(response.status, expected, `${method} ${path}: ${text}`); return JSON.parse(text).data;
}
const e = process.env;
const client = new MongoClient(`mongodb://${e.MONGODB_HOST}:${e.MONGODB_PORT || 27017}`, { auth: { username: e.MONGODB_USER, password: e.MONGODB_PASSWORD }, authSource: e.MONGODB_AUTH_SOURCE || e.MONGODB_DATABASE, serverSelectionTimeoutMS: 5000, tls: e.MONGODB_TLS === "true" });
const db = client.db(e.MONGODB_DATABASE || "workflow");
try {
  const before = await call("GET", "/api/models");
  const created = await call("POST", "/api/models", input); ids.push(created.id);
  const getRow = async () => (await call("GET", "/api/models")).models.find(m => m.id === created.id);
  let row = await getRow(); assert.equal(row.upstreamModel, marker); assert.equal(row.hasCredential, true); assert.equal(row.revision, 1);
  const stored = await db.collection("workflow16080_models").findOne({ _id: row.id });
  const credential = await db.collection("workflow16080_credentials").findOne({ _id: stored.credentialId });
  assert(!JSON.stringify(stored).includes(key)); assert.equal(credential.apiKey, key); assert.equal(credential.secret, undefined);
  await call("PUT", "/api/models", { id: row.id, revision: row.revision, input: { ...input, name: "已编辑的临时验收", apiKey: "" } });
  await call("PUT", "/api/models", { id: row.id, revision: 1, input }, 409);
  row = await getRow(); assert.equal(row.revision, 2); assert.equal(row.hasCredential, true); assert.equal(row.name, "已编辑的临时验收");
  const retained = await db.collection("workflow16080_credentials").findOne({ _id: credential._id });
  assert.equal(retained.apiKey, key); assert.equal(retained.secret, undefined);
  if (!before.models.some(m => m.type === "llm" && m.isDefault)) {
    await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "default" }); assert.equal((await getRow()).isDefault, true);
    await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "disable" }, 409);
    await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "delete" }, 409);
    await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "unsetDefault" });
  }
  // This target is deliberately blocked before a provider request or any billing.
  const probe = await call("POST", "/api/models/test", { id: row.id, revision: row.revision, confirmed: true }); assert.equal(probe.success, false); assert.match(probe.message, /本地|内网|保留/);
  await call("POST", "/api/models/test", { id: row.id, revision: row.revision, confirmed: true }, 429);
  await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "disable" }); row = await getRow(); assert.equal(row.isActive, false);
  await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "enable" }); row = await getRow(); assert.equal(row.isActive, true);
  await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "delete" }); row = await getRow(); assert(row.deletedAt);
  await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "enable" }, 409);
  await call("PATCH", "/api/models", { id: row.id, revision: row.revision, action: "restore" }); row = await getRow(); assert(!row.deletedAt); assert.equal(row.isActive, false);
  console.log("Model integration passed: plaintext credential persistence, API key non-disclosure, key retention, optimistic locking, defaults, soft delete/restore, SSRF blocking and test rate limits. No real provider request was made.");
} finally {
  for (const id of ids) {
    const settings = await db.collection("workflow16080_settings").findOne({ _id: "defaults" });
    for (const [type, modelId] of Object.entries(settings?.defaults || {})) if (modelId === id) await db.collection("workflow16080_settings").updateOne({ _id: "defaults", [`defaults.${type}`]: id }, { $unset: { [`defaults.${type}`]: "" } });
    await db.collection("workflow16080_credentials").deleteMany({ modelId: id });
    await db.collection("workflow16080_models").deleteOne({ _id: id, "metadata.upstreamModel": marker });
  }
  await client.close();
}
