import { spawn } from "node:child_process";
import { ModelError } from "../capabilities/base";

export type ProcessResult = { stdout: string; stderr: string; exitCode: number; durationMs: number; truncated: boolean; stopped?: "timeout" | "cancelled" };

export function hostEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TMPDIR: "/tmp", NODE_ENV: "production" };
}

/** Not an OS sandbox. Never load login profiles or pass server credentials to the shell. */
export async function runHostProcess(
  input: { command: string; cwd: string; timeout: number },
  allowed: () => Promise<boolean> = async () => true,
): Promise<ProcessResult> {
  if (process.platform === "win32") throw new ModelError(503, "本机 Shell 当前仅支持 macOS / Linux");
  if (!(await allowed())) throw new ModelError(409, "执行已取消或权限已变化");
  return new Promise((resolve, reject) => {
    const started = Date.now(), limit = 256 * 1024;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false;
    let stopped: ProcessResult["stopped"], settled = false, checking = false;
    const child = spawn("/bin/sh", ["-c", input.command], { cwd: input.cwd, env: hostEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* Process group already exited. */ }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: NonNullable<ProcessResult["stopped"]>) => {
      if (stopped || settled) return;
      stopped = reason;
      killGroup("SIGTERM");
      escalation = setTimeout(() => killGroup("SIGKILL"), 300);
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeout * 1000);
    const watch = setInterval(async () => {
      if (checking || settled) return;
      checking = true;
      try { if (!(await allowed())) stop("cancelled"); } catch { stop("cancelled"); }
      finally { checking = false; }
    }, 250);
    function cleanup() {
      clearTimeout(timeout); clearInterval(watch);
      if (escalation) clearTimeout(escalation);
      // Also terminate background descendants after the shell exits.
      killGroup("SIGKILL");
    }
    function append(old: Buffer, chunk: Buffer) {
      if (old.length + chunk.length > limit) truncated = true;
      return Buffer.concat([old, chunk.subarray(0, Math.max(0, limit - old.length))]);
    }
    child.stdout.on("data", (b: Buffer) => { stdout = append(stdout, b); });
    child.stderr.on("data", (b: Buffer) => { stderr = append(stderr, b); });
    child.once("error", () => { settled = true; cleanup(); reject(new ModelError(503, "无法启动本机 Shell，请检查工作目录和系统权限")); });
    child.once("exit", () => killGroup("SIGKILL"));
    child.once("close", (code) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: stopped === "timeout" ? 124 : stopped === "cancelled" ? 130 : code ?? -1, durationMs: Date.now() - started, truncated, ...(stopped ? { stopped } : {}) });
    });
  });
}
