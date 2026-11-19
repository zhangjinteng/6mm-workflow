import { ChevronRight, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { WorkspaceSidebar } from "../workspace-sidebar";
import "./skills.css";
export default function SkillsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="workspace">
      <WorkspaceSidebar active="skills" />
      <div className="workspace-main">
        <header className="topbar">
          <span>
            工作空间
            <ChevronRight size={13} />
            <strong>Skill 管理</strong>
          </span>
          <span className="topbar-right">
            <ShieldCheck size={14} />
            仅本地访问<span className="avatar">W</span>
          </span>
        </header>
        <main className="model-content skill-content">{children}</main>
        <footer className="workspace-footer">
          <span>ZJT Workflow</span>
          <span>
            LOCAL DEVELOPMENT <span className="footer-dot" />
          </span>
        </footer>
      </div>
    </div>
  );
}
