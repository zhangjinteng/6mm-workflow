import { createHash, randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { after } from "next/server";
import type { Message } from "@mariozechner/pi-ai";
import { assemble, agentSchemas, type Options } from "./catalog";
import { target } from "../capabilities/models";
import { ModelError } from "../capabilities/base";
import { contextForModel, checkText, transcript } from "./context";
import { openCompression } from "../compression/service";
import { sessionInfo } from "../sandbox/store";
import { tokens } from "../compression/engine";
import { imageBlocks, prepareResources, systemPrompt } from "./resources";
import { completion } from "./model";
import { drive, result, unfinished } from "./engines";
import { shellJob } from "../host-shell/service";
import { terminalShellStatus } from "../../lib/host-shell";
import {
  claim,
  collection,
  leaseMs,
  load,
  save,
  view,
  type Run,
  type Input,
} from "./store";

async function previous(sessionId?: string) {
  return sessionId
    ? (await collection()).findOne(
        { sessionId, status: "completed" },
        { sort: { createdAt: -1 } },
      )
    : null;
}
async function catalog(p: Options) {
  const conn = await target("llm", p.modelId),
    prior = await previous(p.sessionId);
  const c = await assemble(
    p,
    conn.input,
    prior?.catalog.files.map((f) => f.id),
  );
  return { conn, prior, c };
}
async function work(id: string) {
  const run = await claim(id);
  if (!run) return view(await load(id));
  const ctrl = new AbortController(),
    col = await collection(),
    owner = run.owner;
  const heartbeat = setInterval(() => {
    void col
      .updateOne(
        { _id: id, status: "running", owner },
        { $set: { leaseUntil: new Date(Date.now() + leaseMs) } },
      )
      .then((v) => {
        if (!v.matchedCount) ctrl.abort();
      })
      .catch(() => ctrl.abort());
  }, 2000);
  try {
    if (run.inFlight)
      throw new ModelError(409, "上次工具执行结果未确认，已停止以避免重复执行");
    const conn = await target("llm", run.modelId);
    if (conn.revision !== run.modelRevision)
      throw new ModelError(409, "运行期间模型配置已更改");
    if (!run.ready) {
      const prior = run.parentId ? await load(run.parentId) : undefined;
      await checkText(run, run.input.message);
      const resources = await prepareResources(
        run.catalog,
        run.input,
        prior?.sandboxSessionId,
        prior?.catalog,
      );
      run.sandboxSessionId = resources.sandboxSessionId;
      let reference = "";
      if (run.input.datasetChunks.length) {
        await checkText(run, JSON.stringify(run.input.datasetChunks));
        const { engine } = await openCompression(run.modelId);
        const filtered = await engine.dataset(
          run.input.message,
          run.input.datasetChunks,
          4000,
        );
        reference = "\n已检索的资料：" + JSON.stringify(filtered.chunks);
      }
      if (prior) {
        const old = JSON.stringify(transcript(prior.messages));
        await checkText(run, old);
        const text =
          tokens(old) > 4000
            ? (
                await (
                  await openCompression(run.modelId)
                ).engine.text(old, 4000)
              ).text
            : old;
        run.messages = [
          {
            role: "user",
            content: "上一轮会话资料：" + text,
            timestamp: prior.createdAt.getTime(),
          },
        ];
        run.historyCount = run.messages.length;
      }
      run.messages.push({
        role: "user",
        content:
          resources.promptContext + reference + "\n\n" + run.input.message,
        timestamp: Date.now(),
      });
      run.ready = true;
      await save(run);
    }
    if (run.sandboxSessionId) await sessionInfo(run.sandboxSessionId);
    const images = await imageBlocks(run.catalog);
    await drive(
      run,
      conn,
      async () => {
        ctrl.signal.throwIfAborted();
        if (run.steps >= run.input.maxSteps)
          throw new ModelError(422, "达到 Agent 最大模型轮数");
        const context = await contextForModel(run, conn.input.maxContext);
        await checkText(run, JSON.stringify(transcript(context)));
        const current = run.messages[run.historyCount];
        const messages = context.map((m): Message =>
          m === current &&
          images.length &&
          m.role === "user" &&
          typeof m.content === "string"
            ? { ...m, content: [{ type: "text", text: m.content }, ...images] }
            : m,
        );
        return completion(
          conn,
          systemPrompt,
          messages,
          run.catalog.tools,
          ctrl.signal,
        );
      },
      ctrl.signal,
    );
  } catch (e) {
    if (run.owner) {
      run.status = "failed";
      run.error = e instanceof ModelError ? e.message : "Agent 执行失败";
      await save(run).catch(async (err) => {
        if ((await load(id)).status === "running") throw err;
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
  return view(await load(id));
}
function schedule(id: string) {
  after(async () => {
    await work(id);
  });
}
export async function wakeShellApproval(id: string) {
  let r = await load(z.uuid().parse(id));
  if (r.status === "waiting_approval" && r.pendingApproval) {
    const execution = await shellJob(r.pendingApproval.executionId);
    if (terminalShellStatus(execution.status)) {
      await (await collection()).updateOne({ _id: r._id, status: "waiting_approval", "pendingApproval.executionId": execution.id }, {
        $set: { status: "queued", updatedAt: new Date() }, $unset: { pendingApproval: "" },
      });
      r = await load(r._id);
    }
  }
  return r;
}
export async function status(id: string) {
  const r = await wakeShellApproval(id);
  if (
    r.status === "queued" ||
    (r.status === "running" &&
      r.leaseUntil &&
      r.leaseUntil.getTime() < Date.now())
  )
    schedule(id);
  return view(r);
}
async function start(p: Input) {
  const col = await collection(),
    id = p.runId ?? randomUUID();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(p))
    .digest("hex");
  const existing = async () => {
    const r = await col.findOne({ _id: id });
    if (r && r.fingerprint !== fingerprint)
      throw new ModelError(409, "runId 已用于不同请求");
    return r ? status(id) : null;
  };
  const replay = await existing();
  if (replay) return replay;
  const { conn, c, prior } = await catalog(p);
  if (c.excluded.length)
    throw new ModelError(
      422,
      "无法装配所选工具：" + c.excluded.map((t) => t.name).join(", "),
    );
  const now = new Date(),
    messages: Message[] = [];
  const r: Run = {
    _id: id,
    status: "queued",
    sessionId: p.sessionId ?? randomUUID(),
    active: true,
    input: p,
    catalog: c,
    fingerprint,
    modelId: conn.id,
    modelRevision: conn.revision,
    parentId: prior?._id,
    messages,
    historyCount: messages.length,
    steps: 0,
    ready: false,
    responses: {},
    createdAt: now,
    updatedAt: now,
  };
  try {
    await col.insertOne(r);
  } catch (e) {
    if (!(e instanceof MongoServerError) || e.code !== 11000) throw e;
    const duplicate = await existing();
    if (duplicate) return duplicate;
    throw new ModelError(409, "该会话已有运行或等待中的任务");
  }
  if (p.background) {
    schedule(id);
    return view(r);
  }
  return work(id);
}
async function resume(p: z.infer<typeof agentSchemas.resumeAgent>) {
  const r = await load(p.runId),
    key = createHash("sha256").update(p.interactionId).digest("hex");
  if (Object.hasOwn(r.responses, key)) {
    if (r.responses[key] !== p.answer)
      throw new ModelError(409, "该追问已经收到其他回答");
    return status(r._id);
  }
  if (
    r.status !== "waiting_input" ||
    r.pending?.interactionId !== p.interactionId
  )
    throw new ModelError(409, "运行没有匹配的待答问题");
  const call = unfinished(r.messages).find((c) => c.id === p.interactionId);
  if (!call) throw new ModelError(409, "缺少待答工具记录");
  const col = await collection();
  const updated = await col.updateOne(
    {
      _id: r._id,
      status: "waiting_input",
      "pending.interactionId": p.interactionId,
    },
    {
      $set: {
        status: "queued",
        updatedAt: new Date(),
        ["responses." + key]: p.answer,
      },
      $unset: { pending: "" },
      $push: { messages: result(call, p.answer) },
    },
  );
  if (!updated.matchedCount) return resume(p);
  return work(r._id);
}
export async function agentNode(name: string, input: unknown) {
  if (name === "previewAgentTools")
    return (await catalog(agentSchemas.previewAgentTools.parse(input))).c;
  if (name === "resumeAgent")
    return resume(agentSchemas.resumeAgent.parse(input));
  return start(agentSchemas.runAgent.parse(input));
}
