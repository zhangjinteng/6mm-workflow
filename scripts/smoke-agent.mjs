import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
const base = process.env.AGENT_TEST_BASE ?? "http://127.0.0.1:16080";
async function api(path, opts) {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  const v = text ? JSON.parse(text) : {};
  assert.ok(r.ok, path + " " + r.status + " " + (v.error || ""));
  return v.data;
}
const node = async (name, params) =>
  (
    await api("/api/workflow/nodes/" + name, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params }),
    })
  ).result;
const { models } = await api("/api/models");
const modelId =
  process.env.AGENT_TEST_MODEL_ID ??
  models.find((m) => m.type === "llm" && m.isActive)?.id;
assert.ok(modelId, "需要启用的语言模型");
for (const engine of ["default", "pi"]) {
  const token = "WF-" + randomBytes(10).toString("hex").toUpperCase();
  const file = await api("/api/files?name=acceptance.txt", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "仓库盘点记录\n本批次核验码为 " + token + "。\n记录结束。",
  });
  try {
    const options = { engine, modelId, attachments: [{ fileId: file.id }] };
    const preview = await node("previewAgentTools", options);
    assert.ok(preview.tools.some((t) => t.name === "read_files"));
    const request = {
      ...options,
      runId: randomUUID(),
      message:
        "请先调用 read_files 读取所附盘点记录，然后仅返回正文中的完整核验码。",
    };
    const r = await node("runAgent", request);
    assert.equal(r.status, "completed", r.error);
    const call = r.trace
      .flatMap((t) => t.toolCalls ?? [])
      .find((c) => c.name === "read_files" && c.args.fileIds.includes(file.id));
    assert.ok(call, JSON.stringify(r.trace));
    assert.ok(
      r.trace.some(
        (t) =>
          t.type === "toolResult" &&
          t.toolCallId === call.id &&
          !t.isError &&
          t.result.includes(token),
      ),
    );
    assert.equal(r.answer.trim(), token);
    const stored = await api("/api/agent/runs/" + r.runId);
    assert.deepEqual(stored.trace, r.trace);
    assert.equal((await node("runAgent", request)).updatedAt, r.updatedAt);
    console.log(
      JSON.stringify({
        engine,
        runId: r.runId,
        model: r.trace[0].model,
        readCall: call.id,
        steps: r.steps,
        answer: r.answer,
      }),
    );
    const bounded = await node("runAgent", {
      ...request,
      runId: randomUUID(),
      maxSteps: 1,
    });
    assert.equal(bounded.status, "failed");
    assert.match(bounded.error, /最大模型轮数/);
    assert.equal(bounded.steps, 1);
    const bg = await node("runAgent", {
      ...request,
      runId: randomUUID(),
      background: true,
    });
    const cancelPath = "/api/agent/runs/" + bg.runId + "/cancel";
    assert.equal(
      (await api(cancelPath, { method: "POST" })).status,
      "cancelled",
    );
    assert.equal(
      (await api(cancelPath, { method: "POST" })).status,
      "cancelled",
    );
    console.log(engine, "step limit and idempotent cancellation passed");
  } finally {
    await api("/api/files/" + file.id, { method: "DELETE" });
  }
}
