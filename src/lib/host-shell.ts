import { z } from "zod";

export const shellModes = ["isolated-shell", "host-shell", "danger-full-access"] as const;
export type ShellMode = typeof shellModes[number];
export const shellModeNames: Record<ShellMode, string> = {
  "isolated-shell": "隔离 Shell",
  "host-shell": "本机 Shell · 审批",
  "danger-full-access": "完全访问 · 无需确认",
};
export const hostCommandSchema = z.object({
  command: z.string().trim().min(1).max(65536).refine(v => !v.includes("\0"), "命令含无效字符"),
  cwd: z.string().min(1).max(4096).optional(),
  timeout: z.int().min(1).max(120).default(30),
}).strict();
export const shellPolicySchema = z.object({
  mode: z.enum(shellModes),
  cwd: z.string().min(1).max(4096),
  revision: z.int().nonnegative(),
  acknowledged: z.boolean().default(false),
}).strict().refine(p => p.mode === "isolated-shell" || p.acknowledged, "启用本机执行前必须确认风险");
export type ShellPolicy = { mode: ShellMode; cwd: string; revision: number; updatedAt?: string; disabled: boolean };
export type ShellJobView = {
  id: string; command: string; cwd: string; mode: ShellMode; timeout: number;
  status: "pending" | "running" | "completed" | "failed" | "denied" | "cancelled" | "expired" | "interrupted";
  reason: string; source: "manual" | "agent"; runId?: string; toolCallId?: string;
  stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; truncated?: boolean;
  createdAt: string; finishedAt?: string; expiresAt: string;
};

// Exact strings only: operators, substitutions, options and unknown programs require approval.
const diagnostics = new Set(["pwd", "/bin/pwd", "whoami", "/usr/bin/whoami", "uname", "uname -a", "/usr/bin/uname", "/usr/bin/uname -a"]);
export function requiresShellApproval(command: string) { return !diagnostics.has(command.trim()); }
export function terminalShellStatus(status: ShellJobView["status"]) { return status !== "pending" && status !== "running"; }

export function redactShellText(text: string, secrets: string[] = []) {
  let result = text;
  for (const secret of [...new Set(secrets)].filter(s => s.length >= 4).sort((a, b) => b.length - a.length)) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|password|passwd|token|secret)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
