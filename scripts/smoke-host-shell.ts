import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { database } from "../src/server/model-config/repository";
import { getShellPolicy, setShellPolicy, submitHostCommand, decideShellJob, shellJob, listShellJobs } from "../src/server/host-shell/service";
import { assemble, agentSchemas } from "../src/server/agent/catalog";
import { modelInputSchema } from "../src/lib/model-config";
import { assistant, descriptor, type Connection } from "../src/server/agent/model";
import { drive } from "../src/server/agent/engines";
import { collection, claim, load, type Run } from "../src/server/agent/store";
import { wakeShellApproval } from "../src/server/agent/service";

async function main() {
const ids: string[] = [], runIds: string[] = [];
const marker = randomUUID(), cwd = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-host-smoke-")));
const db = await database(), original = await getShellPolicy();
const fixtureSecret = "smoke-secret-" + randomUUID(), credentialId = randomUUID();
let changed = false;
async function mode(value: "isolated-shell" | "host-shell" | "danger-full-access") {
  const p = await getShellPolicy();
  const result = await setShellPolicy({ mode: value, cwd, revision: p.revision, acknowledged: true }); changed = true; return result;
}
async function submit(command: string, extra: { timeout?: number; requestId?: string } = {}) {
  const row = await submitHostCommand({ command, timeout: extra.timeout ?? 5 }, { requestId: extra.requestId ?? randomUUID() });
  if (!ids.includes(row.id)) ids.push(row.id);
  return row;
}
try {
  assert.equal(original.mode, "isolated-shell", "请先切换回隔离模式，再运行会临时切换权限的验收脚本");
  assert(!(await listShellJobs(100)).some(j => j.status === "pending" || j.status === "running"), "已有待审批/执行中的任务，验收未开始");
  await db.collection("workflow16080_credentials").insertOne({ _id: credentialId as never, modelId: marker, apiKey: fixtureSecret, createdAt: new Date() });
  const virtual = await submit("pwd"); assert.equal(virtual.cwd, "/workspace"); assert.equal(virtual.status, "completed"); assert.match(virtual.stdout || "", /workspace/);
  await mode("host-shell");
  const diagnostic = await submit("pwd"); assert.equal(diagnostic.status, "completed"); assert(diagnostic.stdout?.includes(cwd));
  const requestId = randomUUID(), command = "printf 'once\\n' >> once.txt";
  const pending = await submit(command, { requestId }); assert.equal(pending.status, "pending");
  await assert.rejects(readFile(path.join(cwd, "once.txt")));
  await assert.rejects(submit("printf changed", { requestId }), /另一条命令/);
  const approved = await decideShellJob(pending.id, "approve"); assert.equal(approved.status, "completed");
  await decideShellJob(pending.id, "approve"); await submit(command, { requestId });
  assert.equal(await readFile(path.join(cwd, "once.txt"), "utf8"), "once\n");
  const denied = await submit("printf denied > denied.txt"); await decideShellJob(denied.id, "deny"); assert.equal((await shellJob(denied.id)).status, "denied"); await assert.rejects(readFile(path.join(cwd, "denied.txt")));
  const expired = await submit("printf expired"); await db.collection("workflow16080_shell_executions").updateOne({ _id: expired.id as never }, { $set: { expiresAt: new Date(0) } }); assert.equal((await decideShellJob(expired.id, "approve")).status, "expired");
  const invalidated = await submit("printf invalidated"); await mode("host-shell"); assert.equal((await shellJob(invalidated.id)).status, "cancelled");
  const current = await getShellPolicy();
  await assert.rejects(submitHostCommand({ command: "pwd" }, { requestId: randomUUID(), policyRevision: current.revision - 1 }), /模式已变化/);
  const base = process.env.HOST_SHELL_TEST_BASE ?? "http://127.0.0.1:16080";
  const httpRequest = { requestId: randomUUID(), command: "pwd", timeout: 5, policyRevision: current.revision };
  const post = (body: unknown, headers = {}) => fetch(base + "/api/shell/executions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(httpRequest, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ ...httpRequest, policyRevision: current.revision - 1 })).status, 409);
  const apiResponse = await post(httpRequest); assert.equal(apiResponse.status, 200);
  const apiJob = (await apiResponse.json()).data; ids.push(apiJob.id); assert.equal(apiJob.status, "completed");
  assert.equal((await (await post(httpRequest)).json()).data.id, apiJob.id);
  const log = (await (await fetch(base + "/api/shell/executions/" + apiJob.id)).json()).data;
  assert.equal(log.payload, undefined); assert.equal(log.cwd, cwd);
  const httpPendingResponse = await post({ ...httpRequest, requestId: randomUUID(), command: "printf 'http-approved'" });
  assert.equal(httpPendingResponse.status, 200);
  const httpPending = (await httpPendingResponse.json()).data; ids.push(httpPending.id); assert.equal(httpPending.status, "pending");
  const decision = (confirmed: boolean) => fetch(base + "/api/shell/executions/" + httpPending.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve", confirmed }) });
  assert.equal((await decision(false)).status, 400);
  const httpApprovedResponse = await decision(true); assert.equal(httpApprovedResponse.status, 200);
  const httpApproved = (await httpApprovedResponse.json()).data; assert.equal(httpApproved.status, "completed"); assert.equal(httpApproved.stdout, "http-approved");
  await mode("danger-full-access");
  const full = await submit("printf unrestricted"); assert.equal(full.status, "completed"); assert.equal(full.stdout, "unrestricted");
  const timeout = await submit("/bin/sleep 10 & wait", { timeout: 1 }); assert.equal(timeout.exitCode, 124);
  const cancelledPromise = submit("/bin/sleep 10 & wait", { timeout: 5 });
  let running: Awaited<ReturnType<typeof listShellJobs>>[number] | undefined;
  for (let i = 0; i < 30 && !running; i++) { running = (await listShellJobs()).find(j => j.status === "running"); if (!running) await new Promise(r => setTimeout(r, 50)); }
  assert(running); await decideShellJob(running.id, "cancel"); const cancelled = await cancelledPromise; assert.equal(cancelled.status, "cancelled");
  const redacted = await submit(`printf '${fixtureSecret}'`); assert.equal(redacted.stdout, "[REDACTED]"); assert(!JSON.stringify(await shellJob(redacted.id)).includes(fixtureSecret));
  const saved = await db.collection("workflow16080_shell_executions").findOne({ _id: redacted.id as never }); assert.equal(saved?.payload, undefined); assert(!JSON.stringify(saved).includes(fixtureSecret));
  await mode("host-shell");
  const model = modelInputSchema.parse({ providerId: "deepseek", upstreamModel: "deepseek-flash", baseUrl: "https://api.deepseek.com/v1" });
  for (const engine of ["default", "pi"] as const) {
    const input = agentSchemas.runAgent.parse({ engine, selectedTools: ["host_shell"], message: "synthetic approval test" }), catalog = await assemble(input, model);
    const id = randomUUID(); runIds.push(id);
    const row: Run = { _id: id, sessionId: randomUUID(), active: true, status: "queued", input, fingerprint: marker, catalog, modelId: randomUUID(), modelRevision: 1, messages: [{ role: "user", content: "synthetic approval test", timestamp: Date.now() }], historyCount: 0, steps: 0, ready: true, responses: {}, createdAt: new Date(), updatedAt: new Date() };
    await (await collection()).insertOne(row);
    const r = await claim(id); assert(r);
    const conn: Connection = { id: row.modelId, input: model, apiKey: "fixture-not-used", revision: 1 };
    const first = assistant(descriptor(conn)); first.stopReason = "toolUse"; first.content = [{ type: "toolCall", id: "synthetic-call", name: "host_shell", arguments: { command: `printf '${engine}'`, timeout: 5 } }];
    await assert.rejects(drive(r, conn, async () => first, new AbortController().signal));
    const paused = await load(id); assert.equal(paused.status, "waiting_approval"); assert(paused.pendingApproval);
    ids.push(paused.pendingApproval.executionId);
    await decideShellJob(paused.pendingApproval.executionId, "approve");
    const woke = await wakeShellApproval(id); assert.equal(woke.status, "queued");
    const resumed = await claim(id); assert(resumed);
    const final = assistant(descriptor(conn)); final.content = [{ type: "text", text: "done" }];
    await drive(resumed, conn, async () => final, new AbortController().signal);
    const finished = await load(id); assert.equal(finished.status, "completed");
    assert.equal(finished.messages.filter(m => m.role === "toolResult" && m.toolCallId === "synthetic-call").length, 1);
    console.log(`Synthetic ${engine} Agent approval/resume passed; no model request sent.`);
  }
  console.log("Host Shell integration passed: isolation, approval binding, deduplication, deny, expiry, mode invalidation, full access, timeout, cancel, redaction, persisted logs and both Agent engines.");
} finally {
  if (changed) { const p = await getShellPolicy(); await setShellPolicy({ mode: "isolated-shell", cwd: original.cwd, revision: p.revision, acknowledged: false }); }
  await db.collection("workflow16080_shell_executions").deleteMany({ _id: { $in: ids } } as never);
  await db.collection("workflow16080_agent_runs").deleteMany({ _id: { $in: runIds } } as never);
  await db.collection("workflow16080_credentials").deleteOne({ _id: credentialId as never, modelId: marker });
  await rm(cwd, { recursive: true, force: true });
}
}
main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : "Host Shell test failed"); process.exit(1); });
