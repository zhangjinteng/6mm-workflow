import assert from "node:assert/strict";
import test, { after } from "node:test";
const base = "http://127.0.0.1:16080";
const json = { "content-type": "application/json" };
async function api(path, init = {}, status = 200) {
  const response = await fetch(base + path, {
    ...init,
    signal: AbortSignal.timeout(180000),
  });
  const text = await response.text();
  assert.equal(response.status, status, path + " " + text.slice(0, 350));
  return text ? JSON.parse(text) : {};
}
const models = (await api("/api/models")).data.models;
const model =
  models.find((m) => m.id === process.env.COMPRESSION_MODEL_ID) ??
  models.find((m) => m.isActive && m.type === "llm");
assert.ok(model, "需要启用一个语言模型");
const modelId = model.id;
const cleanup = [];
after(async () => {
  for (const [url, status] of cleanup.reverse())
    await api(url, { method: "DELETE" }, status);
});
async function node(name, params, status = 200) {
  const { data, error } = await api(
    "/api/workflow/nodes/" + name,
    {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        params: { modelId, ...params },
        variables: { sentinel: "ok" },
      }),
    },
    status,
  );
  if (status !== 200) return error;
  assert.ok(data.requestId);
  assert.equal(data.variables.sentinel, "ok");
  const stats = data.compression ?? data.result;
  if ("budgetTokens" in stats) {
    assert.ok(stats.tokensAfter <= stats.budgetTokens);
    console.log(
      name,
      stats.strategy ?? "auto",
      stats.tokensBefore,
      "->",
      stats.tokensAfter,
      "calls",
      stats.modelCalls,
    );
  }
  return data;
}
const material = "验收结论：蓝桥订单的核对日期是周五，负责人是小林。\n".repeat(
  55,
);
const bytes = Buffer.from(material);
const file = (
  await api(
    "/api/files?name=compression-fixture.txt",
    { method: "POST", body: bytes },
    201,
  )
).data;
cleanup.push(["/api/files/" + file.id, 204]);
const user = { role: "user", content: "谁负责核对蓝桥订单？" };
test("59 nodes and four parameter schemas", async () => {
  assert.equal((await api("/api/capabilities")).data.length, 38);
  const html = await (await fetch(base + "/nodes")).text();
  assert.equal((html.match(/class="method"/g) ?? []).length, 59);
  for (const name of [
    "compressHistory",
    "compressFile",
    "compressToolResult",
    "compressDatasetResults",
  ])
    assert.equal((await api("/api/capabilities/" + name)).data.name, name);
});
test("file from ID: real summary, original download unchanged", async () => {
  const r = (await node("compressFile", { fileId: file.id, budgetTokens: 100 }))
    .result;
  assert.equal(r.filename, "compression-fixture.txt");
  assert.ok(r.modelCalls >= 1);
  assert.match(r.text, /小林/);
  assert.deepEqual(
    Buffer.from(
      await (
        await fetch(base + "/api/files/" + file.id + "/download")
      ).arrayBuffer(),
    ),
    bytes,
  );
});
test("history: checkpoint and unchanged system and current question", async () => {
  const system = { role: "system", content: "中文作答。" };
  const r = (
    await node("compressHistory", {
      messages: [
        system,
        { role: "user", content: material },
        { role: "assistant", content: "收到" },
        user,
      ],
      budgetTokens: 240,
    })
  ).result;
  assert.ok(r.modelCalls >= 1);
  assert.match(r.checkpoint, /小林/);
  assert.deepEqual(r.messages[0], system);
  assert.deepEqual(r.messages.at(-1), user);
  const next = await node("modelChat", {
    messages: r.messages,
    compression: { enabled: true },
  });
  assert.equal(next.compression.modelCalls, 0);
  const answer =
    next.result.choices?.[0]?.message?.content ??
    next.result.content?.map((c) => c.text).join("");
  assert.match(answer, /小林/);
});
test("tool output: JSON summary and cheap rule path", async () => {
  const r = (
    await node("compressToolResult", {
      toolName: "checkOrder",
      result: { report: material },
      budgetTokens: 100,
    })
  ).result;
  assert.match(r.text, /小林/);
  assert.ok(r.modelCalls >= 1);
  const rules = (
    await node("compressToolResult", {
      toolName: "export",
      result: "文件 https://example.com/" + "section/".repeat(200),
      budgetTokens: 20,
    })
  ).result;
  assert.equal(rules.strategy, "rules");
  assert.equal(rules.modelCalls, 0);
});
const chunks = [
  { id: "blue", text: "蓝桥订单由小林核对。", source: "验收记录", score: 1 },
  {
    id: "grey",
    text: "旧仓库盘点 " + "无关 ".repeat(500),
    source: "盘点",
    score: 0.1,
  },
];
test("dataset: real model picks original ID and source", async () => {
  const r = (
    await node("compressDatasetResults", {
      query: user.content,
      chunks,
      budgetTokens: 120,
    })
  ).result;
  assert.equal(r.strategy, "selection");
  assert.deepEqual(r.selectedIds, ["blue"]);
  assert.deepEqual(r.chunks, [chunks[0]]);
});
test("modelChat: disabled by default and explicitly false", async () => {
  for (const extra of [
    {},
    {
      compression: {
        enabled: false,
        sources: [
          { type: "file", fileId: "00000000-0000-4000-8000-000000000000" },
        ],
      },
    },
  ]) {
    const r = await node("modelChat", {
      messages: [{ role: "user", content: "请只回复 OK" }],
      ...extra,
    });
    assert.ok(!("compression" in r));
    assert.ok(r.result.choices?.length || r.result.content?.length);
  }
});
test("automatic chat reads file, accepts tool result and filters dataset, returns separate metadata", async () => {
  const irrelevant = {
    ...chunks[1],
    text:
      "旧仓库盘点 " +
      " shelf".repeat(Math.min(90000, Math.ceil(model.maxContext * 0.21))),
  };
  const r = await node("modelChat", {
    messages: [user],
    compression: {
      enabled: true,
      sources: [
        { type: "file", fileId: file.id },
        {
          type: "tool",
          toolName: "orderStatus",
          result: { state: "confirmed" },
        },
        {
          type: "dataset",
          query: user.content,
          chunks: [chunks[0], irrelevant],
        },
      ],
    },
  });
  assert.equal(r.compression.sources.length, 3);
  assert.ok(r.compression.modelCalls >= 1);
  assert.deepEqual(r.compression.sources[2].selectedIds, ["blue"]);
  const answer =
    r.result.choices?.[0]?.message?.content ??
    r.result.content?.map((c) => c.text).join("");
  assert.match(answer, /小林/);
});
test("moderation rejects raw file before compression and oversized fixed request returns 422", async () => {
  const policy = (
    await api(
      "/api/integrations",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          name: "compression-smoke",
          kind: "moderation",
          enabled: true,
          blockedTerms: ["蓝桥订单"],
        }),
      },
      201,
    )
  ).data;
  cleanup.push(["/api/integrations/" + policy.id, 200]);
  const denied = await node(
    "modelChat",
    {
      messages: [{ role: "user", content: "总结附件" }],
      policyId: policy.id,
      compression: {
        enabled: true,
        sources: [{ type: "file", fileId: file.id }],
      },
    },
    422,
  );
  assert.match(denied, /审核/);
  assert.match(
    await node("compressHistory", { messages: [user], budgetTokens: 1 }, 422),
    /差额/,
  );
});
