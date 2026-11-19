import capabilities from "@/server/capabilities/manifest.json";
import originalNodes from "@/server/workflow-nodes/manifest.json";
import Link from "next/link";
import {
  BookOpen,
  GitBranch,
  Cpu,
  ChevronDown,
  CircleHelp,
  Terminal,
} from "lucide-react";
export function WorkspaceSidebar({
  active,
  models,
}: {
  active: "models" | "skills" | "shell";
  models?: number;
}) {
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-icon">
          <GitBranch size={20} />
        </span>
        <span>
          ZJT <strong>Workflow</strong>
        </span>
      </Link>
      <div className="workspace-switch">
        <span className="workspace-avatar">W</span>
        <span>
          本地工作空间<small>Local workspace</small>
        </span>
        <ChevronDown size={14} />
      </div>
      <div className="nav-caption">工作空间</div>
      <nav>
        <Link
          className={active === "models" ? "nav-item selected" : "nav-item"}
          aria-current={active === "models" ? "page" : undefined}
          href="/models"
        >
          <Cpu size={17} />
          模型配置
          {models !== undefined && <span className="nav-count">{models}</span>}
        </Link>
        <Link className="nav-item" href="/nodes">
          <GitBranch size={17} />
          工作流节点
          <small>{originalNodes.nodes.length + capabilities.length}</small>
        </Link>
        <Link
          className={active === "skills" ? "nav-item selected" : "nav-item"}
          aria-current={active === "skills" ? "page" : undefined}
          href="/skills"
        >
          <BookOpen size={17} />
          Skill 管理
        </Link>
        <Link className={active === "shell" ? "nav-item selected" : "nav-item"} aria-current={active === "shell" ? "page" : undefined} href="/shell" title="Shell 控制台">
          <Terminal size={17} />Shell 控制台
        </Link>
      </nav>
      <div className="sidebar-bottom">
        <span className="local-badge">
          <span />
          本地服务 · 16080
        </span>
        <a href="/api/health" target="_blank" title="服务状态" rel="noreferrer">
          <CircleHelp size={17} />
        </a>
      </div>
    </aside>
  );
}
