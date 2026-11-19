"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clock, LoaderCircle, Play, RefreshCw, Save, ShieldAlert, Square, Terminal, X } from "lucide-react";
import { shellModes, shellModeNames, terminalShellStatus, type ShellMode, type ShellPolicy, type ShellJobView } from "@/lib/host-shell";

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "请求失败");
  return json.data;
}
const names: Record<ShellJobView["status"], string> = { pending: "待审批", running: "执行中", completed: "已完成", failed: "失败", denied: "已拒绝", cancelled: "已取消", expired: "已过期", interrupted: "结果待核对" };
export default function ShellConsole() {
  const [policy, setPolicy] = useState<ShellPolicy | null>(null), [mode, setMode] = useState<ShellMode>("isolated-shell"), [cwd, setCwd] = useState("");
  const [jobs, setJobs] = useState<ShellJobView[]>([]), [selected, setSelected] = useState<string>(), [command, setCommand] = useState("pwd"), [timeout, setTimeoutValue] = useState(30);
  const [busy, setBusy] = useState<string>(), [error, setError] = useState(""), [notice, setNotice] = useState(""), [consent, setConsent] = useState(false), [confirmMode, setConfirmMode] = useState(false);
  const modal = useRef<HTMLDialogElement>(null), mounted = useRef(false);
  const pendingRequest = useRef<{ signature: string; id: string } | undefined>(undefined);
  const loadJobs = useCallback(async () => { const values = await request<ShellJobView[]>("/api/shell/executions"); setJobs(values); return values; }, []);
  useEffect(() => {
    let live = true;
    request<ShellPolicy>("/api/shell/policy").then(p => { if (live) { setPolicy(p); setMode(p.mode); setCwd(p.cwd); } }).catch(e => { if (live) setError(e.message); });
    request<ShellJobView[]>("/api/shell/executions").then(values => { if (live) setJobs(values); }).catch(e => { if (live) setError(e.message); });
    const timer = setInterval(() => { if (live) void loadJobs().catch(() => {}); }, 2500);
    mounted.current = true;
    return () => { live = false; mounted.current = false; clearInterval(timer); };
  }, [loadJobs]);
  useEffect(() => { if (confirmMode) modal.current?.showModal(); else modal.current?.close(); }, [confirmMode]);
  async function act(id: string, decision: "approve" | "deny" | "cancel") {
    setBusy(id); setError("");
    try { await request(`/api/shell/executions/${id}`, "POST", { decision, confirmed: true }); await loadJobs(); }
    catch (e) { setError((e as Error).message); } finally { if (mounted.current) setBusy(undefined); }
  }
  async function saveMode() {
    if (!policy) return;
    setBusy("policy"); setError("");
    try {
      const p = await request<ShellPolicy>("/api/shell/policy", "PUT", { mode, cwd, revision: policy.revision, acknowledged: mode !== "isolated-shell" && consent });
      setPolicy(p); setCwd(p.cwd); setConfirmMode(false); setConsent(false); setNotice("执行模式已保存"); await loadJobs();
    } catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }
  async function execute() {
    setBusy("execute"); setError(""); setNotice("");
    try {
      const signature = JSON.stringify({ command, timeout, revision: policy?.revision });
      if (pendingRequest.current?.signature !== signature) pendingRequest.current = { signature, id: crypto.randomUUID() };
      const row = await request<ShellJobView>("/api/shell/executions", "POST", { command, timeout, requestId: pendingRequest.current.id, policyRevision: policy?.revision });
      pendingRequest.current = undefined;
      setSelected(row.id); await loadJobs();
    } catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }
  const pending = jobs.filter(j => j.status === "pending"), detail = jobs.find(j => j.id === selected) ?? jobs[0];
  return <>
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE / EXECUTION</div><h1><Terminal size={23} />Shell 控制台</h1></div><button className="icon-button" aria-label="刷新执行日志" title="刷新执行日志" onClick={() => void loadJobs().catch(e => setError(e.message))}><RefreshCw size={17} /></button></div>
    {error && <div className="error-banner" role="alert"><ShieldAlert size={17} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={15} /></button></div>}
    {notice && <div className="shell-notice" role="status"><Check size={15} />{notice}</div>}
    <section className="shell-policy" aria-label="执行模式设置"><div className="shell-section-title"><h2>执行权限</h2><span className={`shell-badge ${policy?.mode === "danger-full-access" ? "warning" : ""}`}>{policy ? shellModeNames[policy.mode] : "正在读取"}</span></div>
      <div className="shell-setting-row"><label className="field"><span>执行模式</span><div className="select-wrap"><select aria-label="执行模式" value={mode} onChange={e => { setMode(e.target.value as ShellMode); setConsent(false); }} disabled={!!busy || !policy}>{shellModes.map(m => <option key={m} value={m} disabled={policy?.disabled && m !== "isolated-shell"}>{shellModeNames[m]}</option>)}</select><ChevronDown size={15} /></div></label>
        <label className="field shell-cwd"><span>本机工作目录</span><input aria-label="本机工作目录" value={cwd} onChange={e => setCwd(e.target.value)} disabled={!!busy || !policy} /></label>
        <button className="button secondary" disabled={!!busy || !policy || (mode === policy.mode && cwd === policy.cwd)} onClick={() => { setConsent(false); if (mode === "isolated-shell") void saveMode(); else setConfirmMode(true); }}><Save size={15} />保存设置</button></div>
      {policy?.mode !== "isolated-shell" && policy && <div className="shell-warning"><ShieldAlert size={17} /><span>{policy.mode === "danger-full-access" ? "完全访问已开启：本机命令不再逐次确认。" : "仅固定诊断命令自动执行，其他命令需要一次性审批。"}真实命令使用服务进程的系统账号权限，工作目录不构成安全隔离。</span></div>}
      {policy?.disabled && <p className="shell-warning">服务端已禁止本机执行。</p>}
    </section>
    <section className="shell-command" aria-label="执行命令"><div className="shell-section-title"><h2>命令</h2><code>{policy?.mode === "isolated-shell" ? "/workspace（虚拟）" : policy?.cwd}</code></div>
      <label className="field"><span className="shell-command-label">{policy?.mode === "isolated-shell" ? "隔离工作区" : "本机 /bin/sh"}</span><textarea aria-label="Shell 命令" value={command} onChange={e => setCommand(e.target.value)} rows={4} maxLength={65536} spellCheck={false} /></label>
      <div className="shell-command-footer"><label>超时（秒）<input aria-label="执行超时秒数" type="number" min={1} max={policy?.mode === "isolated-shell" ? 60 : 120} value={timeout} onChange={e => setTimeoutValue(Number(e.target.value))} /></label><button className="button primary" disabled={!!busy || !command.trim() || !policy || (policy.disabled && policy.mode !== "isolated-shell")} onClick={() => void execute()}>{busy === "execute" ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}执行</button></div>
    </section>
    {pending.length > 0 && <section className="shell-approvals" aria-label="待审批命令"><div className="shell-section-title"><h2>待审批 <span>{pending.length}</span></h2></div>{pending.map(j => <article key={j.id} className="shell-approval"><div><span className="shell-badge warning">{j.source === "agent" ? "Agent 请求" : "手工提交"}</span><code>{j.cwd}</code><span>{j.timeout} 秒</span></div><pre>{j.command}</pre><p>{j.reason}</p><footer><span><Clock size={13} />有效至 {new Date(j.expiresAt).toLocaleTimeString("zh-CN")}</span><button className="button secondary" disabled={!!busy} onClick={() => void act(j.id, "deny")}><X size={14} />拒绝</button><button className="button primary" disabled={!!busy} onClick={() => void act(j.id, "approve")}><Check size={14} />批准本次执行</button></footer></article>)}</section>}
    <section className="shell-history" aria-label="执行日志"><div className="shell-section-title"><h2>执行日志 <span>{jobs.length}</span></h2></div><div className="shell-log-layout"><div className="shell-log-list">{!jobs.length && <div className="shell-empty"><Terminal size={25} /><span>暂无执行记录</span></div>}{jobs.map(j => <button key={j.id} className={`shell-log-row ${detail?.id === j.id ? "selected" : ""}`} onClick={() => setSelected(j.id)}><span><span className={`shell-badge ${j.status === "failed" || j.status === "pending" ? "warning" : ""}`}>{names[j.status]}</span><time>{new Date(j.createdAt).toLocaleTimeString("zh-CN")}</time></span><code>{j.command}</code><small>{shellModeNames[j.mode]} · {j.source === "agent" ? "Agent" : "手工"}</small></button>)}</div><div className="shell-log-detail">{detail ? <><header><span className="shell-badge">{names[detail.status]}</span><span>退出码 {detail.exitCode ?? "—"} · {detail.durationMs ?? 0} ms</span>{!terminalShellStatus(detail.status) && <button className="icon-button" title="取消执行" aria-label="取消执行" onClick={() => void act(detail.id, "cancel")}><Square size={14} /></button>}</header><dl><dt>工作目录</dt><dd><code>{detail.cwd}</code></dd><dt>执行标识</dt><dd><code>{detail.id}</code></dd>{detail.runId && <><dt>Agent 运行</dt><dd><code>{detail.runId}</code></dd></>}</dl><pre className="shell-output">{detail.stdout || (detail.status === "pending" ? "等待用户审批，尚未执行。" : "（无标准输出）")}</pre>{detail.stderr && <pre className="shell-stderr">{detail.stderr}</pre>}{detail.reason && <p className="muted">{detail.reason}</p>}{detail.truncated && <p className="muted">输出超过上限，已截断。</p>}</> : <div className="shell-empty">尚未选择执行记录</div>}</div></div></section>
    <dialog ref={modal} className="model-dialog" aria-label="确认本机执行权限" onCancel={e => { e.preventDefault(); if (!busy) setConfirmMode(false); }}><div className="dialog-heading"><h2>确认本机执行权限</h2><button className="icon-button" aria-label="关闭权限确认" disabled={!!busy} onClick={() => setConfirmMode(false)}><X size={19} /></button></div><div className="confirm-body"><p><strong>{shellModeNames[mode]}</strong></p><p>命令将直接运行在此电脑上，可以访问当前系统账号能访问的文件、网络和凭据。{mode === "danger-full-access" && "完全访问模式不会再逐条询问，删除、安装、推送及部署命令也会直接执行。"}</p><p><code>{cwd}</code></p><label className="test-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我理解上述权限及风险，允许启用此模式。</label></div><footer className="dialog-footer"><button className="button secondary" disabled={!!busy} onClick={() => setConfirmMode(false)}>取消</button><button className="button danger" disabled={!consent || !!busy} onClick={() => void saveMode()}><ShieldAlert size={15} />确认启用</button></footer></dialog>
  </>;
}
