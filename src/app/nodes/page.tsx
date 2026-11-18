import { ArrowLeft, ArrowUpRight, GitBranch } from "lucide-react";
import { nodeTypes } from "@/server/workflow-nodes/registry";
import capabilities from "@/server/capabilities/manifest.json";
export default function NodesPage() {
  return <main className="nodes-page"><a className="inline-link" href="/models"><ArrowLeft size={15} />模型配置</a><h1><GitBranch size={24} />工作流节点</h1><div className="node-list">{[...nodeTypes,...capabilities.map(c=>c.name)].map(name => <div key={name}><span className="method">POST</span><strong>{name}</strong><code>/api/workflow/nodes/{name}</code><ArrowUpRight size={15} /></div>)}</div></main>;
}
