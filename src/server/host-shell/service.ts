import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { database } from "../model-config/repository";
import { ModelError } from "../capabilities/base";
import { hostCommandSchema, redactShellText, requiresShellApproval, shellPolicySchema, terminalShellStatus, type ShellJobView, type ShellMode, type ShellPolicy } from "../../lib/host-shell";
import { runHostProcess } from "./process";

type Policy = { _id: string; mode: ShellMode; cwd: string; revision: number; updatedAt: Date };
type Job = Omit<ShellJobView, "id" | "createdAt" | "finishedAt" | "expiresAt"> & {
  _id: string; dedupeKey: string; fingerprint: string; policyRevision: number;
  approvalRequired: boolean; approvedAt?: Date; owner?: string;
  payload?: { command: string }; createdAt: Date; expiresAt: Date; startedAt?: Date; finishedAt?: Date;
};
const jobs = async () => (await database()).collection<Job>("workflow16080_shell_executions");
const policies = async () => (await database()).collection<Policy>("workflow16080_shell_policy");
let indexes: Promise<unknown> | undefined;
async function prepare() {
  indexes ??= jobs().then(c => c.createIndexes([
    { key: { dedupeKey: 1 }, unique: true, name: "shell_request_identity" },
    { key: { createdAt: -1 }, name: "shell_history" },
    { key: { runId: 1, toolCallId: 1 }, name: "shell_agent_call" },
  ])).catch(e => { indexes = undefined; throw e; });
  await indexes;
}
export function hostDisabled() {
  return process.env.WORKFLOW_HOST_SHELL_DISABLED === "1" || process.env.WORKFLOW_SANDBOX_MODE === "workspace-write";
}
export async function canonicalCwd(value: string) {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new ModelError(400, "工作目录必须为本机绝对路径");
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isDirectory()) throw Error();
    return resolved;
  } catch { throw new ModelError(400, "本机工作目录不存在或不可访问"); }
}
export async function getShellPolicy(): Promise<ShellPolicy> {
  const row = await (await policies()).findOne({ _id: "policy" });
  return { mode: row?.mode ?? "isolated-shell", cwd: row?.cwd ?? process.cwd(), revision: row?.revision ?? 0, updatedAt: row?.updatedAt.toISOString(), disabled: hostDisabled() };
}
export async function setShellPolicy(body: unknown) {
  const p = shellPolicySchema.parse(body);
  if (hostDisabled() && p.mode !== "isolated-shell") throw new ModelError(403, "服务端已禁用本机 Shell");
  const cwd = await canonicalCwd(p.cwd), now = new Date();
  try {
    const result = await (await policies()).updateOne(
      { _id: "policy", revision: p.revision },
      { $set: { mode: p.mode, cwd, updatedAt: now }, $inc: { revision: 1 } },
      { upsert: p.revision === 0 },
    );
    if (!result.matchedCount && !result.upsertedCount) throw new ModelError(409, "Shell 模式已变更，请刷新后重试");
  } catch (e) { if (e instanceof MongoServerError && e.code === 11000) throw new ModelError(409, "Shell 模式已变更，请刷新后重试"); throw e; }
  await (await database()).collection("workflow16080_shell_policy_events").insertOne({ mode: p.mode, cwd, revision: p.revision + 1, createdAt: now });
  // Existing approvals and running jobs never inherit newly elevated permissions.
  await (await jobs()).updateMany({ status: "pending", policyRevision: { $ne: p.revision + 1 } }, { $set: { status: "cancelled", reason: "模式或工作目录已变更，请重新提交", finishedAt: now }, $unset: { payload: "" } });
  return getShellPolicy();
}
function view(row: Job): ShellJobView {
  return { id: row._id, command: row.command, cwd: row.cwd, mode: row.mode, timeout: row.timeout,
    status: row.status, reason: row.reason, source: row.source, runId: row.runId, toolCallId: row.toolCallId,
    stdout: row.stdout, stderr: row.stderr, exitCode: row.exitCode, durationMs: row.durationMs, truncated: row.truncated,
    createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString(), expiresAt: row.expiresAt.toISOString() };
}
async function secrets() {
  const env = Object.entries(process.env).filter(([k]) => /KEY|SECRET|TOKEN|PASS|CREDENTIAL/i.test(k)).map(([, v]) => v || "");
  const keys = await (await database()).collection("workflow16080_credentials").find({ apiKey: { $type: "string" } }, { projection: { apiKey: 1 } }).limit(10000).toArray();
  return [...env, ...keys.map(v => String(v.apiKey))];
}
async function expire() {
  const c = await jobs(), now = new Date();
  await c.updateMany({ status: "pending", expiresAt: { $lte: now } }, { $set: { status: "expired", reason: "审批已过期，请重新提交", finishedAt: now }, $unset: { payload: "" } });
  // A lost process must not be treated as safe to replay after restart.
  const stale = await c.find({ status: "running", startedAt: { $lt: new Date(Date.now() - 125000) } }).toArray();
  for (const row of stale) await c.updateOne({ _id: row._id, status: "running", owner: row.owner }, { $set: { status: "interrupted", reason: "执行结果不明确，禁止自动重试，请核对后重新提交", finishedAt: now }, $unset: { payload: "", owner: "" } });
}
export async function shellJob(id: string) {
  await expire();
  const row = await (await jobs()).findOne({ _id: z.uuid().parse(id) });
  if (!row) throw new ModelError(404, "Shell 执行记录不存在");
  return view(row);
}
export async function listShellJobs(limit = 50) {
  await prepare(); await expire();
  return (await (await jobs()).find({}).sort({ createdAt: -1 }).limit(Math.min(100, Math.max(1, limit))).toArray()).map(view);
}
export class ShellApprovalRequired extends Error {
  constructor(public job: ShellJobView) { super("本机命令等待用户审批"); }
}
async function policyAllows(row: Job) {
  const p = await getShellPolicy();
  if (p.revision !== row.policyRevision || p.mode !== row.mode) return false;
  if (row.mode === "isolated-shell") return process.env.WORKFLOW_SANDBOX_MODE !== "workspace-write";
  if (p.disabled) return false;
  if (row.runId) {
    const run = await (await database()).collection<{ _id: string; active: boolean; status: string }>("workflow16080_agent_runs").findOne({ _id: row.runId, active: true, status: { $in: ["running", "waiting_approval"] } }, { projection: { _id: 1 } });
    if (!run) return false;
  }
  return true;
}
const active = globalThis as typeof globalThis & { workflowHostShellActive?: Set<string> };
async function execute(row: Job) {
  const c = await jobs();
  if (!row.payload || row.status !== "pending" || (row.approvalRequired && !row.approvedAt)) return view(row);
  if (row.expiresAt.getTime() <= Date.now()) return shellJob(row._id);
  if (!(await policyAllows(row))) {
    await c.updateOne({ _id: row._id, status: "pending" }, { $set: { status: "cancelled", reason: "执行权限或 Agent 状态已变化", finishedAt: new Date() }, $unset: { payload: "" } });
    return shellJob(row._id);
  }
  active.workflowHostShellActive ??= new Set();
  if (active.workflowHostShellActive.size >= 2) {
    await c.updateOne({ _id: row._id, status: "pending" }, { $set: { status: "failed", reason: "执行并发已满，命令未执行；请稍后新建请求", finishedAt: new Date() }, $unset: { payload: "" } });
    return shellJob(row._id);
  }
  const owner = randomUUID();
  active.workflowHostShellActive.add(owner);
  try {
    const knownSecrets = await secrets();
    const claimed = await c.findOneAndUpdate({ _id: row._id, status: "pending", expiresAt: { $gt: new Date() } }, { $set: { status: "running", owner, startedAt: new Date() } }, { returnDocument: "after" });
    if (!claimed) return shellJob(row._id);
    try {
      const allowed = async () => {
        const current = await c.findOne({ _id: row._id, status: "running", owner }, { projection: { _id: 1 } });
        return !!current && await policyAllows(row);
      };
      const result = row.mode === "isolated-shell"
        ? await isolated(row.payload.command, row.timeout, allowed)
        : await runHostProcess({ command: row.payload.command, cwd: row.cwd, timeout: row.timeout }, allowed);
      await c.updateOne({ _id: row._id, owner }, { $set: {
        status: result.stopped === "cancelled" ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
        stdout: redactShellText(result.stdout, knownSecrets), stderr: redactShellText(result.stderr, knownSecrets), exitCode: result.exitCode,
        durationMs: result.durationMs, truncated: result.truncated, finishedAt: new Date(),
        reason: result.stopped === "timeout" ? "执行超时" : result.stopped === "cancelled" ? "执行已取消或权限已变更" : result.exitCode ? "命令返回非零退出码" : "",
      }, $unset: { payload: "", owner: "" } });
    } catch {
      await c.updateOne({ _id: row._id, owner }, { $set: { status: "failed", reason: "执行失败或审计不可用；不会自动重试", finishedAt: new Date() }, $unset: { payload: "", owner: "" } });
    }
    return shellJob(row._id);
  } finally { active.workflowHostShellActive.delete(owner); }
}
export async function submitHostCommand(body: unknown, identity: { requestId?: string; runId?: string; toolCallId?: string; policyRevision?: number } = {}) {
  const p = hostCommandSchema.parse(body), policy = await getShellPolicy();
  if (identity.policyRevision !== undefined && identity.policyRevision !== policy.revision) throw new ModelError(409, "执行模式已变化，请刷新后重新提交；命令未执行");
  const cwd = policy.mode === "isolated-shell" ? "/workspace" : await canonicalCwd(p.cwd ?? policy.cwd);
  const dedupeKey = identity.runId && identity.toolCallId ? `agent:${identity.runId}:${identity.toolCallId}` : `manual:${z.uuid().parse(identity.requestId ?? randomUUID())}`;
  const fingerprint = createHash("sha256").update(JSON.stringify({ command: p.command, cwd, timeout: p.timeout })).digest("hex");
  await prepare(); await expire();
  const c = await jobs();
  const replay = async () => {
    const old = await c.findOne({ dedupeKey });
    if (!old) return null;
    if (old.fingerprint !== fingerprint) throw new ModelError(409, "请求标识已用于另一条命令，禁止更改审批内容");
    return old.status === "pending" ? execute(old) : view(old);
  };
  const old = await replay(); if (old) return old;
  if ((policy.disabled && policy.mode !== "isolated-shell") || (identity.runId && policy.mode === "isolated-shell")) throw new ModelError(403, "本机 Shell 未启用，请先在 Shell 控制台切换模式");
  if (policy.mode === "isolated-shell" && p.timeout > 60) throw new ModelError(400, "隔离 Shell 最长执行 60 秒");
  const approvalRequired = policy.mode === "host-shell" && requiresShellApproval(p.command);
  const row: Job = {
    _id: randomUUID(), dedupeKey, fingerprint, policyRevision: policy.revision, mode: policy.mode, cwd, timeout: p.timeout,
    command: redactShellText(p.command, await secrets()), payload: { command: p.command }, approvalRequired,
    status: "pending", reason: approvalRequired ? "命令具有副作用或不在固定诊断白名单内，需要一次性审批" : "",
    source: identity.runId ? "agent" : "manual", runId: identity.runId, toolCallId: identity.toolCallId,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60000),
  };
  try { await c.insertOne(row); }
  catch (e) { if (!(e instanceof MongoServerError) || e.code !== 11000) throw e; const duplicate = await replay(); if (duplicate) return duplicate; throw e; }
  return execute(row);
}
async function isolated(command: string, timeout: number, allowed: () => Promise<boolean>) {
  const { createSession, closeSession } = await import("../sandbox/store");
  const { sandboxNode } = await import("../sandbox/nodes");
  if (!(await allowed())) throw new ModelError(409, "执行已取消");
  const session = await createSession({ mode: "isolated-shell" }), started = Date.now();
  let checking = false;
  const watch = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { if (!(await allowed())) await closeSession(session.sessionId); } catch { await closeSession(session.sessionId).catch(() => {}); }
    finally { checking = false; }
  }, 250);
  try {
    const result = z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() }).parse(await sandboxNode("sandboxShell", { sessionId: session.sessionId, command, timeout }));
    return { ...result, durationMs: Date.now() - started, truncated: false, ...(!(await allowed()) ? { stopped: "cancelled" as const } : {}) };
  } finally { clearInterval(watch); await closeSession(session.sessionId); }
}
export async function decideShellJob(id: string, decision: "approve" | "deny" | "cancel") {
  await expire();
  const c = await jobs(), row = await c.findOne({ _id: z.uuid().parse(id) });
  if (!row) throw new ModelError(404, "Shell 执行记录不存在");
  if (terminalShellStatus(row.status)) return view(row);
  if (decision !== "approve") {
    await c.updateOne({ _id: id, status: { $in: ["pending", "running"] } }, { $set: { status: decision === "deny" ? "denied" : "cancelled", reason: decision === "deny" ? "用户拒绝执行" : "用户取消执行", finishedAt: new Date() }, $unset: { payload: "" } });
    return shellJob(id);
  }
  if (row.status !== "pending") return view(row);
  if (!(await policyAllows(row))) throw new ModelError(409, "模式、工作目录或 Agent 状态已变更，请重新提交");
  const approved = await c.findOneAndUpdate({ _id: id, status: "pending", expiresAt: { $gt: new Date() } }, { $set: { approvedAt: new Date() } }, { returnDocument: "after" });
  return approved ? execute(approved) : shellJob(id);
}
