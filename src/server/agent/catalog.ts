import { z } from "zod";
import { extname } from "node:path";
import { documentSchemas } from "../capabilities/documents";
import { compressionSchemas } from "../compression/schema";
import { target } from "../capabilities/models";
import { getFile } from "../capabilities/files";
import { ModelError } from "../capabilities/base";
import { sandboxSchemas } from "../sandbox/nodes";
import { metadata } from "../skills/package";
import { content, getSkill } from "../skills/repository";
import type { ModelInput } from "../../lib/model-config";
import { hostCommandSchema } from "../../lib/host-shell";
import { getShellPolicy } from "../host-shell/service";

const ids = z.array(z.uuid()).max(20);
const options = {
  engine: z.enum(["default", "pi"]).optional(),
  modelId: z.uuid().optional(),
  policyId: z.uuid().optional(),
  censor: z.boolean().default(false),
  sessionId: z.uuid().optional(),
  selectedTools: z.array(z.string().min(1).max(100)).max(32).default([]),
  attachments: z
    .array(z.object({ fileId: z.uuid() }).strict())
    .max(20)
    .default([]),
  canSelectFile: z.boolean().default(true),
  skills: z
    .array(
      z
        .object({ skillId: z.uuid(), version: z.int().positive().optional() })
        .strict(),
    )
    .max(12)
    .default([]),
  editSkillId: z.uuid().optional(),
  sandbox: z.enum(["off", "workspace-write", "isolated-shell"]).default("off"),
  modalities: z
    .object({
      vision: z.boolean().default(false),
      audio: z.enum(["off", "transcribe", "native"]).default("off"),
      video: z.boolean().default(false),
      sttModelId: z.uuid().optional(),
    })
    .strict()
    .optional(),
};
export const agentSchemas = {
  previewAgentTools: z.object(options).strict(),
  runAgent: z
    .object({
      ...options,
      message: z.string().trim().min(1).max(64000),
      datasetChunks:
        compressionSchemas.compressDatasetResults.shape.chunks.default([]),
      maxSteps: z.int().min(1).max(24).default(8),
      runId: z.uuid().optional(),
      background: z.boolean().default(false),
    })
    .strict(),
  resumeAgent: z
    .object({
      runId: z.uuid(),
      interactionId: z.string().min(1),
      answer: z.string().trim().min(1).max(16000),
    })
    .strict(),
};
export type Options = z.infer<typeof agentSchemas.previewAgentTools>;
export const sandboxTools = {
  sandbox_read_file: "sandboxReadFile",
  sandbox_write_file: "sandboxWriteFile",
  sandbox_edit_file: "sandboxEditFile",
  sandbox_search: "sandboxSearch",
  sandbox_get_file_url: "sandboxGetFileUrl",
  sandbox_shell: "sandboxShell",
} as const;
export const toolSchemas: Record<string, z.ZodType> = Object.assign(
  Object.create(null),
  {
    htmlToMarkdown: documentSchemas.htmlToMarkdown,
    textToChunks: documentSchemas.textToChunks,
    read_files: z.object({ fileIds: ids.min(1) }).strict(),
    update_plan: z
      .object({ steps: z.array(z.string().min(1).max(500)).min(1).max(24) })
      .strict(),
    ask_agent: z.object({ question: z.string().min(1).max(2000) }).strict(),
    host_shell: hostCommandSchema,
    ...Object.fromEntries(
      Object.entries(sandboxTools).map(([name, node]) => [
        name,
        z.object(sandboxSchemas[node].shape).omit({ sessionId: true }).strict(),
      ]),
    ),
  },
);
const descriptions: Record<string, string> = {
  htmlToMarkdown: "Convert supplied HTML to Markdown.",
  textToChunks: "Split supplied text into chunks.",
  read_files:
    "Read the text of attached documents. Use the exact fileIds listed in the user message.",
  ask_agent: "Pause to ask the user a necessary clarification.",
  update_plan: "Record the steps in the current plan.",
  sandbox_read_file: "Read a text file in the session workspace.",
  sandbox_write_file: "Write a text file in the session workspace.",
  sandbox_edit_file: "Replace matching text in session files.",
  sandbox_search: "Find matching workspace paths.",
  sandbox_get_file_url: "Export session files for download.",
  sandbox_shell: "Run a command inside the isolated virtual filesystem.",
  host_shell: "Run a REAL command on the server host, outside the virtual sandbox. Use real absolute cwd paths, not virtual /workspace paths. Server policy may require user approval. Never attempt to change execution policy or approve your own commands.",
};
export async function assemble(
  p: Options,
  model: ModelInput,
  previous: string[] = [],
) {
  const files = [];
  for (const id of new Set([
    ...(p.canSelectFile ? previous : []),
    ...p.attachments.map((a) => a.fileId),
  ])) {
    const file = await getFile(id).catch((e) => {
      if (
        e instanceof ModelError &&
        e.status === 404 &&
        !p.attachments.some((a) => a.fileId === id)
      )
        return null;
      throw e;
    });
    if (!file) continue;
    const { meta } = file;
    const ext = extname(meta.name).toLowerCase();
    const kind = /^\.(txt|md|csv|html|pdf|docx|pptx|xlsx)$/.test(ext)
      ? "document"
      : /^image\/(png|jpeg|webp|gif)$/.test(meta.mime)
        ? "image"
        : meta.mime.startsWith("audio/")
          ? "audio"
          : meta.mime.startsWith("video/")
            ? "video"
            : "unsupported";
    files.push({ id, name: meta.name, kind, mime: meta.mime, size: meta.size });
  }
  if (files.length > 20)
    throw new ModelError(422, "一个会话最多引用 20 个附件");
  const skills: {
    skillId: string;
    name: string;
    description: string;
    version: number | null;
    revision: number;
    draft: boolean;
    path: string;
  }[] = [];
  const wanted = p.editSkillId
    ? [{ skillId: p.editSkillId, version: undefined }]
    : p.skills;
  for (const s of wanted) {
    if (skills.some((x) => x.skillId === s.skillId))
      throw new ModelError(400, "Skill 重复");
    const row = await getSkill(s.skillId);
    const draft = s.skillId === p.editSkillId;
    const version = draft ? null : (s.version ?? row.active);
    if (!draft && !row.history.some((x) => x.number === version))
      throw new ModelError(409, "Skill 缺少发布版本");
    const published = row.history.find((v) => v.number === version);
    const labels =
      published && published.archive !== row.draft
        ? metadata((await content(row, published.number)).markdown)
        : row;
    skills.push({
      skillId: s.skillId,
      name: labels.name,
      description: labels.description,
      version,
      revision: row.revision,
      draft,
      path: "skills/" + s.skillId,
    });
  }
  const mode =
    p.sandbox === "off" && skills.length ? "workspace-write" : p.sandbox;
  const effectiveMode =
    process.env.WORKFLOW_SANDBOX_MODE === "workspace-write" && mode !== "off"
      ? "workspace-write"
      : mode;
  const enabled = new Set<string>(["ask_agent", "update_plan"]);
  let hostPolicy: { revision: number; mode: string; cwd: string } | undefined;
  if (p.selectedTools.includes("host_shell")) {
    const host = await getShellPolicy();
    if (!host.disabled && host.mode !== "isolated-shell") {
      enabled.add("host_shell");
      hostPolicy = { revision: host.revision, mode: host.mode, cwd: host.cwd };
    }
  }
  if (p.canSelectFile) enabled.add("read_files");
  if (effectiveMode !== "off") {
    for (const name of Object.keys(sandboxTools))
      if (name !== "sandbox_shell" || effectiveMode === "isolated-shell")
        enabled.add(name);
  }
  for (const name of ["htmlToMarkdown", "textToChunks"])
    if (p.selectedTools.includes(name)) enabled.add(name);
  const excluded = p.selectedTools
    .filter((n) => !enabled.has(n))
    .map((name) => ({
      name,
      reason: Object.hasOwn(toolSchemas, name)
        ? "所需附件或沙箱权限不可用"
        : "未注册本地工具",
    }));
  // Explicit selection narrows the sandbox catalog. Attachment and Skill discovery also work without selection.
  if (p.selectedTools.length)
    for (const name of Object.keys(sandboxTools))
      if (
        !p.selectedTools.includes(name) &&
        !(skills.length && name === "sandbox_read_file")
      )
        enabled.delete(name);
  let sttModelId: string | undefined,
    sttReason = "语音转写未开启";
  if (
    p.modalities?.audio === "transcribe" &&
    files.some((f) => f.kind === "audio")
  ) {
    try {
      sttModelId = (await target("stt", p.modalities.sttModelId)).id;
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      sttReason = e.message;
    }
  }
  const media = files
    .filter((f) => f.kind !== "document")
    .map((f) => {
      if (
        f.kind === "image" &&
        p.modalities?.vision &&
        model.capabilities.includes("vision")
      )
        return { ...f, action: "image", reason: "" };
      if (f.kind === "audio" && sttModelId)
        return { ...f, action: "transcribe", reason: "" };
      const reason =
        f.kind === "image"
          ? "请启用视觉并选择支持视觉的模型"
          : f.kind === "audio" && p.modalities?.audio !== "native"
            ? sttReason
            : f.kind === "video" || f.kind === "audio"
              ? "该协议未开放原生音视频"
              : "文件格式不支持";
      return { ...f, action: "excluded", reason };
    });
  const tools = [...enabled].map((name) => ({
    name,
    description: descriptions[name],
    parameters: z.toJSONSchema(toolSchemas[name], {
      io: "input",
      target: "draft-7",
    }),
  }));
  const engine = z
    .enum(["default", "pi"])
    .parse(p.engine ?? process.env.AGENT_ENGINE ?? "default");
  if (
    !(process.env.WORKFLOW_AGENT_ENGINES ?? "default,pi")
      .split(",")
      .map((s) => s.trim())
      .includes(engine)
  )
    throw new ModelError(422, "该 Agent 引擎未启用");
  if (
    engine === "pi" &&
    (model.protocol !== "openai" ||
      !(
        (model.providerId === "deepseek" &&
          model.upstreamModel === "deepseek-flash") ||
        (process.env.WORKFLOW_AGENT_PI_MODELS ?? "")
          .split(",")
          .includes(model.upstreamModel)
      ))
  )
    throw new ModelError(422, "Pi 仅开放已验证的 OpenAI 兼容模型");
  const unavailable = Object.keys(toolSchemas)
    .filter((name) => !enabled.has(name))
    .map((name) => ({
      name,
      reason:
        name === "sandbox_shell" && effectiveMode === "workspace-write"
          ? "workspace-write 禁止 Shell"
          : name in sandboxTools
            ? "沙箱未开启或未选中"
            : name === "read_files"
              ? "已关闭文件选择"
              : "未选中",
    }));
  return {
    engine,
    tools,
    excluded,
    unavailable,
    files,
    skills,
    sandbox: effectiveMode,
    media,
    sttModelId,
    hostPolicy,
  };
}
export type Catalog = Awaited<ReturnType<typeof assemble>>;
