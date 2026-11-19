import { randomUUID } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import { database } from "../model-config/repository";
import { ModelError } from "../capabilities/base";
import { calls, plain } from "./model";
import type { agentSchemas, Catalog } from "./catalog";
import type { z } from "zod";
export type Input = z.infer<typeof agentSchemas.runAgent>;
export type Run = {
  _id: string;
  sessionId: string;
  active: boolean;
  status:
    | "queued"
    | "running"
    | "waiting_input"
    | "waiting_approval"
    | "completed"
    | "cancelled"
    | "failed";
  input: Input;
  fingerprint: string;
  catalog: Catalog;
  modelId: string;
  modelRevision: number;
  messages: Message[];
  historyCount: number;
  checkpoint?: { cut: number; text: string };
  steps: number;
  ready: boolean;
  answer?: string;
  error?: string;
  owner?: string;
  leaseUntil?: Date;
  inFlight?: string;
  plan?: string[];
  pending?: { interactionId: string; question: string };
  pendingApproval?: { executionId: string; command: string; cwd: string; timeout: number; expiresAt: string };
  responses: Record<string, string>;
  sandboxSessionId?: string;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
};
let indexes: Promise<unknown> | undefined;
export async function collection() {
  const c = (await database()).collection<Run>("workflow16080_agent_runs");
  indexes ??= c
    .createIndexes([
      {
        key: { sessionId: 1 },
        unique: true,
        partialFilterExpression: { active: true },
        name: "active_session",
      },
      { key: { sessionId: 1, createdAt: -1 }, name: "session_history" },
    ])
    .catch((e) => {
      indexes = undefined;
      throw e;
    });
  await indexes;
  return c;
}
export async function load(id: string) {
  const row = await (await collection()).findOne({ _id: id });
  if (!row) throw new ModelError(404, "Agent 运行不存在");
  return row;
}
export function view(r: Run) {
  return {
    runId: r._id,
    sessionId: r.sessionId,
    engine: r.catalog.engine,
    status: r.status,
    steps: r.steps,
    modelId: r.modelId,
    sandboxSessionId: r.sandboxSessionId,
    usage: r.messages
      .slice(r.historyCount)
      .reduce(
        (sum, m) =>
          m.role === "assistant"
            ? {
                input: sum.input + m.usage.input,
                output: sum.output + m.usage.output,
                totalTokens: sum.totalTokens + m.usage.totalTokens,
              }
            : sum,
        { input: 0, output: 0, totalTokens: 0 },
      ),
    plan: r.plan,
    pending: r.pending,
    pendingApproval: r.pendingApproval,
    answer: r.answer,
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    tools: r.catalog.tools.map((t) => t.name),
    skills: r.catalog.skills,
    trace: r.messages
      .slice(r.historyCount)
      .flatMap((m): Record<string, unknown>[] => {
        if (m.role === "assistant")
          return [
            {
              type: "model",
              model: m.model,
              usage: m.usage,
              toolCalls: calls(m).map((c) => ({
                id: c.id,
                name: c.name,
                args: c.arguments,
              })),
            },
          ];
        if (m.role === "toolResult")
          return [
            {
              type: "toolResult",
              toolCallId: m.toolCallId,
              name: m.toolName,
              isError: m.isError,
              result: plain(m),
            },
          ];
        return [];
      }),
  };
}
export const leaseMs = 90000;
export async function claim(id: string) {
  const now = new Date();
  return (await collection()).findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: "queued" },
        { status: "running", leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: {
        owner: randomUUID(),
        status: "running",
        leaseUntil: new Date(Date.now() + leaseMs),
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
}
export async function save(r: Run) {
  const snapshot = {
    ...r,
    updatedAt: new Date(),
    active: ["queued", "running", "waiting_input", "waiting_approval"].includes(r.status),
  };
  if (r.status === "running")
    snapshot.leaseUntil = new Date(Date.now() + leaseMs);
  else {
    delete snapshot.owner;
    delete snapshot.leaseUntil;
  }
  const result = await (
    await collection()
  ).replaceOne({ _id: r._id, owner: r.owner, status: "running" }, snapshot);
  if (!result.matchedCount)
    throw new ModelError(409, "运行已取消或执行权已转移");
  Object.assign(r, snapshot);
  if (!snapshot.owner) {
    delete r.owner;
    delete r.leaseUntil;
  }
}
export async function cancel(id: string) {
  const r = await (
    await collection()
  ).findOneAndUpdate(
    { _id: id, active: true },
    {
      $set: { status: "cancelled", active: false, updatedAt: new Date() },
      $unset: { owner: "", leaseUntil: "", pending: "", pendingApproval: "" },
    },
    { returnDocument: "after" },
  );
  await (await database()).collection<{ _id: string; runId: string; status: string; reason: string; finishedAt: Date; payload?: unknown }>("workflow16080_shell_executions").updateMany(
    { runId: id, status: { $in: ["pending", "running"] } },
    { $set: { status: "cancelled", reason: "关联 Agent 已取消", finishedAt: new Date() }, $unset: { payload: "" } },
  );
  return view(r ?? (await load(id)));
}
