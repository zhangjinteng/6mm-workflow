import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { modelInputSchema } from "../src/lib/model-config";
import { assertLocalRequest, readJson, ModelError } from "../src/server/model-config/security";
import { decryptLegacyCredential } from "../scripts/legacy-model-credential";
import { isPublicAddress, resolveEndpoint, buildProbe, pinnedLookup, connectionError } from "../src/server/model-config/connectivity";
import { modelRoute, POST, PUT, PATCH, TEST } from "../src/server/model-config/http";
import { serialize } from "../src/server/model-config/repository";

const input = { providerId: "custom", upstreamModel: "test-model", baseUrl: "https://api.example.com/v1", apiKey: "test-only-not-a-real-provider-key" };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://localhost:16080/api/models", { method: "POST", headers: { host: "localhost:16080", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("model schema applies safe defaults and supports arbitrary upstream IDs", () => {
  const parsed = modelInputSchema.parse(input); assert.equal(parsed.name, ""); assert.equal(parsed.type, "llm"); assert.deepEqual(parsed.defaultConfig, {}); assert.equal(parsed.upstreamModel, "test-model");
});
for (const [name, patch] of [
  ["missing model", { upstreamModel: "" }], ["unknown provider", { providerId: "invalid" }],
  ["long name", { name: "x".repeat(65) }], ["http endpoint", { baseUrl: "http://example.com/v1" }],
  ["embedded credential", { baseUrl: "https://user:secret@example.com/v1" }], ["endpoint query", { baseUrl: "https://example.com?api_key=secret" }],
  ["header injection", { apiKey: "key\r\nx-injected: true" }], ["oversized output", { maxContext: 10, maxResponse: 20 }],
  ["negative context", { maxContext: -1 }], ["incompatible protocol", { protocol: "anthropic", type: "embedding" }],
  ["operator injection", { defaultConfig: { $where: "x" } }], ["dotted property", { defaultConfig: { "a.b": 1 } }],
  ["prototype key", { defaultConfig: JSON.parse('{"__proto__":{"a":1}}') }], ["plaintext secret", { defaultConfig: { Authorization: "secret" } }],
] as const) test(`schema rejects ${name}`, () => assert.equal(modelInputSchema.safeParse({ ...input, ...patch }).success, false));

test("local guard accepts direct and Next forwarded loopback headers", () => {
  assert.doesNotThrow(() => assertLocalRequest(request({})));
  assert.doesNotThrow(() => assertLocalRequest(request({}, { origin: "http://localhost:16080", "x-forwarded-host": "localhost:16080", "x-forwarded-for": "127.0.0.1" })));
});
for (const headers of [{ host: "evil.test" }, { origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "x-forwarded-for": "203.0.113.1" }, { "x-forwarded-for": "127.0.0.1, 10.0.0.1" }, { "x-forwarded-host": "evil.test" }] as Record<string, string>[]) {
  test(`local guard rejects ${JSON.stringify(headers)}`, () => assert.throws(() => assertLocalRequest(request({}, headers)), ModelError));
}
test("one-time migration decrypts legacy credentials without allowing record swaps", () => {
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("a"));
  const ciphertext = Buffer.concat([cipher.update("secret-provider-key", "utf8"), cipher.final()]);
  const sealed = { version: 1 as const, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  assert.equal(decryptLegacyCredential(sealed, "a", key.toString("base64")), "secret-provider-key");
  assert.throws(() => decryptLegacyCredential(sealed, "b", key.toString("base64")), /解密失败/);
  assert.throws(() => decryptLegacyCredential({ ...sealed, tag: randomBytes(16).toString("base64") }, "a", key.toString("base64")), /解密失败/);
  assert.throws(() => decryptLegacyCredential(sealed, "a", undefined), /MODEL_CREDENTIAL_KEY/);
  assert.throws(() => decryptLegacyCredential(sealed, "a", randomBytes(32).toString("base64")), /解密失败/);
});
test("JSON reader rejects bad content type, malformed JSON and oversized bodies", async () => {
  await assert.rejects(() => readJson(request({}, { "content-type": "text/plain" })), ModelError);
  await assert.rejects(() => readJson(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })), ModelError);
  await assert.rejects(() => readJson(request({ text: "a".repeat(65537) })), ModelError);
  assert.deepEqual(await readJson(request({ ok: true })), { ok: true });
});
for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "192.0.2.1", "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::", "64:ff9b::7f00:1", "2001:db8::1"]) test(`SSRF blocks ${address}`, () => assert.equal(isPublicAddress(address), false));
test("SSRF permits public IPv4 and IPv6", () => { assert(isPublicAddress("1.1.1.1")); assert(isPublicAddress("2606:4700:4700::1111")); });
test("pinned lookup honors both scalar and all-address callback formats", () => {
  for (const address of [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]) {
    const lookup = pinnedLookup(address);
    lookup("example.com", { all: true }, (error, result) => { assert.equal(error, null); assert.deepEqual(result, [address]); });
    lookup("example.com", {}, (error, result, family) => { assert.equal(error, null); assert.equal(result, address.address); assert.equal(family, address.family); });
  }
});
test("Node HTTP family autoselection connects through the pinned lookup", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const options = { agent: false as const, autoSelectFamily: true, lookup: pinnedLookup({ address: "127.0.0.1", family: 4 }) };
      get(`http://pinned-lookup.invalid:${port}`, options, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test("connection failures are classified without leaking exception details", () => {
  assert.match(connectionError({ code: "ERR_INVALID_IP_ADDRESS" }), /服务地址解析异常/);
  assert.match(connectionError({ name: "AbortError" }), /超时/);
  assert.match(connectionError({ code: "ECONNREFUSED" }), /拒绝连接/);
  assert.match(connectionError({ code: "ECONNRESET" }), /重置/);
  assert.match(connectionError({ code: "CERT_HAS_EXPIRED" }), /证书/);
  assert.equal(connectionError({ code: "secret-provider-key" }), "连接失败，请检查上游地址与网络");
});
for (const url of ["http://example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://example.com:444/v1", "https://user:password@example.com/v1"]) test(`endpoint rejects ${url}`, async () => assert.rejects(() => resolveEndpoint(url), ModelError));
test("connectivity probes are bounded and don't relay arbitrary model config", () => {
  const parsed = modelInputSchema.parse(input); const probe = buildProbe(parsed); assert.equal(probe.path, "chat/completions"); assert.equal((probe.body as { max_tokens: number }).max_tokens, 16);
  assert.equal(buildProbe({ ...parsed, type: "embedding" }).path, "embeddings");
  assert.equal(buildProbe({ ...parsed, protocol: "anthropic" }).path, "messages");
  assert.throws(() => buildProbe({ ...parsed, type: "stt" }), ModelError);
});
test("HTTP wrapper never exposes driver errors or credentials", async () => {
  const response = await modelRoute(async () => { throw new Error("mongodb://user:password@private-host"); })(request({}));
  assert.equal(response.status, 503); const text = await response.text(); assert(!text.includes("password")); assert(!text.includes("private-host")); assert.equal(response.headers.get("Cache-Control"), "no-store");
});
test("mutation boundaries reject bad input before touching MongoDB", async () => {
  assert.equal((await POST(request({}))).status, 400); assert.equal((await PUT(request({ id: "invalid" }))).status, 400);
  assert.equal((await PATCH(request({ id: randomUUID(), revision: 1, action: "purge" }))).status, 400);
  assert.equal((await TEST(request({ id: randomUUID(), revision: 1 }))).status, 400);
  assert.equal((await POST(request(input, { origin: "https://evil.test" }))).status, 403);
});
test("serialized writes continue after a rejected edit", async () => {
  const order: number[] = [];
  const first = serialize(async () => { order.push(1); throw new Error("expected"); });
  const second = serialize(async () => { order.push(2); return 2; });
  await assert.rejects(first); assert.equal(await second, 2); assert.deepEqual(order, [1, 2]);
});
