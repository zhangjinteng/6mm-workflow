import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function verifySession(
  base,
  engine,
  beforeResume = async () => {},
) {
  async function api(path, options = {}) {
    const r = await fetch(base + path, options);
    const text = await r.text();
    assert.ok(r.ok, path + " " + r.status + " " + text.slice(0, 250));
    return text ? JSON.parse(text).data : undefined;
  }
  const post = (path, body) =>
    api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const node = async (name, params) =>
    (await post("/api/workflow/nodes/" + name, { params })).result;
  const modelId =
    process.env.AGENT_TEST_MODEL_ID ??
    (await api("/api/models")).models.find(
      (m) => m.type === "llm" && m.isActive,
    ).id;
  const marker = randomUUID(),
    code = randomUUID(),
    confirmation = randomUUID();
  const skill = await post("/api/skills", {
    markdown:
      "---\nname: acceptance-" +
      marker.slice(0, 8) +
      "\ndescription: 盘点验收步骤\n---\n本次写文件时，务必同时写入操作标记 " +
      marker +
      " 和附件正文中的库存码。",
  });
  let rev = skill.revision,
    file,
    run;
  try {
    const published = await post("/api/skills/" + skill.id + "/versions", {
      revision: rev,
    });
    rev = published.revision;
    const edited = await api("/api/skills/" + skill.id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: rev,
        markdown:
          "---\nname: unpublished-draft\ndescription: 未发布草稿\n---\n未发布的操作步骤。",
      }),
    });
    rev = edited.revision;
    file = await api("/api/files?name=inventory.txt", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "库存码为 " + code,
    });
    const p = {
      modelId,
      engine,
      skills: [{ skillId: skill.id, version: published.active }],
      attachments: [{ fileId: file.id }],
    };
    const preview = await node("previewAgentTools", p);
    assert.equal(preview.sandbox, "workspace-write");
    assert.equal(preview.skills[0].description, "盘点验收步骤");
    assert.ok(!preview.tools.some((t) => t.name === "sandbox_shell"));
    run = await node("runAgent", {
      ...p,
      maxSteps: 12,
      message:
        "请逐步执行并调用相应工具：先用 update_plan 记录计划；用 sandbox_read_file 读取所选 Skill 的 SKILL.md；用 read_files 读取上传附件；按 Skill 的要求用 sandbox_write_file 创建 result.txt。写完后必须调用 ask_agent 询问我签收码，收到我的回答后直接输出我给的签收码。",
    });
    assert.equal(
      run.status,
      "waiting_input",
      JSON.stringify({
        status: run.status,
        error: run.error,
        answer: run.answer,
      }),
    );
    assert.ok(run.plan?.length);
    const names = run.trace
      .filter((t) => t.type === "toolResult" && !t.isError)
      .map((t) => t.name);
    for (const n of [
      "update_plan",
      "sandbox_read_file",
      "read_files",
      "sandbox_write_file",
    ])
      assert.ok(names.includes(n), n);
    const saved = await node("sandboxReadFile", {
      sessionId: run.sandboxSessionId,
      path: "result.txt",
    });
    assert.ok(
      saved.content.includes(marker) && saved.content.includes(code),
      saved.content,
    );
    await beforeResume();
    const response = {
      runId: run.runId,
      interactionId: run.pending.interactionId,
      answer: confirmation,
    };
    const resumed = await node("resumeAgent", response);
    assert.equal(resumed.status, "completed", resumed.error);
    assert.ok(resumed.answer.includes(confirmation));
    assert.equal(resumed.sandboxSessionId, run.sandboxSessionId);
    assert.equal(
      resumed.trace.filter(
        (t) =>
          t.type === "toolResult" && t.toolCallId === response.interactionId,
      ).length,
      1,
    );
    assert.deepEqual(
      (await node("resumeAgent", response)).trace,
      resumed.trace,
    );
    const history = await node("previewAgentTools", {
      engine,
      modelId,
      sessionId: run.sessionId,
    });
    assert.ok(history.files.some((f) => f.id === file.id));
    console.log(
      JSON.stringify({
        engine,
        runId: run.runId,
        plan: run.plan.length,
        tools: names,
        status: resumed.status,
        steps: resumed.steps,
        repeatResume: "idempotent",
        historyAttachment: true,
      }),
    );
  } finally {
    if (run?.status === "waiting_input")
      await post("/api/agent/runs/" + run.runId + "/cancel", {});
    if (file) await api("/api/files/" + file.id, { method: "DELETE" });
    await api("/api/skills/" + skill.id + "?revision=" + rev, {
      method: "DELETE",
    });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  for (const engine of ["default", "pi"])
    await verifySession(
      process.env.AGENT_TEST_BASE ?? "http://127.0.0.1:16080",
      engine,
    );
}
