import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { ModelError } from "../capabilities/base";
import { sessionInfo } from "./store";
import type { Entry } from "./workspace";

type Code = { code: string; variables: Record<string, unknown> };
type Job = (
  | { kind: "sandboxShell"; command: string; entries: Entry[] }
  | ({ kind: "runPython" | "runJavaScript" } & Code)
) & { timeout: number };
const runtime = globalThis as typeof globalThis & {
  workflowSandboxJobs?: number;
};
const codeResult = z.object({
  codeReturn: z.record(z.string(), z.json()),
  log: z.string(),
});

// The original service can also be deployed on a private localhost port.
async function codeService(url: string, job: Job & Code) {
  const base = URL.canParse(url) ? new URL(url) : null;
  if (
    !base ||
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(base.hostname) ||
    ["16080", "3011"].includes(base.port) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new ModelError(503, "代码服务须使用独立的本机 HTTP 地址");
  const token = process.env.WORKFLOW_CODE_SANDBOX_TOKEN;
  try {
    const res = await fetch(
      new URL(
        job.kind === "runPython" ? "/sandbox/python" : "/sandbox/js",
        base,
      ),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(job.timeout * 1000),
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify({ code: job.code, variables: job.variables }),
      },
    );
    const reader = res.body?.getReader();
    if (!reader) throw Error();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new ModelError(502, "代码服务响应过大");
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (
      body.success === false &&
      (res.ok || res.status === 400 || res.status === 422)
    ) {
      const message = String(body.message || "代码执行失败").slice(0, 2000);
      throw new ModelError(
        /execut(?:ion|ing).*tim(?:eout|ed out)/i.test(message) ? 504 : 422,
        message,
      );
    }
    if (!res.ok || body.success !== true) throw Error();
    return codeResult.parse(body.data);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (error instanceof Error && error.name === "TimeoutError")
      throw new ModelError(504, "代码执行超时");
    throw new ModelError(503, "独立代码服务不可用或响应无效");
  }
}
async function localWorker(job: Job, sessionId?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        "--max-old-space-size=192",
        path.join(process.cwd(), "workers/sandbox.mjs"),
      ],
      {
        timeout: job.timeout * 1000 + 250,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: { NODE_NO_WARNINGS: "1", NODE_ENV: "production" },
      },
      (error, stdout) => {
        if (watch) clearInterval(watch);
        if (error)
          return reject(
            new ModelError(
              error.killed ? 504 : 503,
              error.killed ? "沙箱执行超时或已取消" : "沙箱进程不可用",
            ),
          );
        try {
          const packet = JSON.parse(stdout);
          if (packet.error)
            throw new ModelError(
              packet.timedOut ? 504 : 422,
              packet.error,
            );
          resolve(packet.result);
        } catch (error) {
          reject(error);
        }
      },
    );
    // This check also works when DELETE reaches a different server process.
    let checking = false;
    const watch = sessionId
      ? setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            await sessionInfo(sessionId);
          } catch {
            child.kill("SIGKILL");
          } finally {
            checking = false;
          }
        }, 250)
      : undefined;
    child.stdin?.on("error", () => {}).end(JSON.stringify(job));
  });
}
export async function run(job: Job, sessionId?: string) {
  if ((runtime.workflowSandboxJobs ?? 0) >= 4)
    throw new ModelError(429, "沙箱并发已满");
  runtime.workflowSandboxJobs = (runtime.workflowSandboxJobs ?? 0) + 1;
  try {
    const url = process.env.WORKFLOW_CODE_SANDBOX_URL;
    if (url && job.kind !== "sandboxShell") return await codeService(url, job);
    return await localWorker(job, sessionId);
  } finally {
    runtime.workflowSandboxJobs--;
  }
}
