import { WorkspaceSidebar } from "../workspace-sidebar";
import { ChevronRight, ShieldCheck } from "lucide-react";
import ShellConsole from "./shell-console";
import "./shell.css";
export default function ShellPage() {
  return <div className="workspace"><WorkspaceSidebar active="shell" /><div className="workspace-main">
    <header className="topbar"><span>工作空间<ChevronRight size={13} /><strong>Shell 控制台</strong></span><span className="topbar-right"><ShieldCheck size={14} />仅本地访问<span className="avatar">W</span></span></header>
    <main className="model-content"><ShellConsole /></main>
    <footer className="workspace-footer"><span>ZJT Workflow</span><span>LOCAL DEVELOPMENT</span></footer>
  </div></div>;
}
