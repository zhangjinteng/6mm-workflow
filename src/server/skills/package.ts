import { Readable } from "node:stream";
import JSZip from "jszip";
import { parseDocument } from "yaml";
import { ModelError } from "../capabilities/base";

export const packageLimit = 50 * 1024 * 1024;
export type SkillPackage = { markdown: string; files: Map<string, Buffer> };
const invalid = (message: string) => new ModelError(422, message);
export function safePath(path: string) {
  if (
    !path ||
    path.length > 512 ||
    /[\\:\x00-\x1f]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw invalid("资源路径无效");
  return path;
}
export function metadata(markdown: string) {
  if (Buffer.byteLength(markdown) > 256 * 1024)
    throw new ModelError(413, "SKILL.md 超过 256 KiB");
  const header =
    /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!header) throw invalid("SKILL.md 需要包含 name 的 YAML 头部");
  const doc = parseDocument(header[1]);
  if (doc.errors.length) throw invalid("SKILL.md 的 YAML 头部无效");
  const name = doc.get("name"),
    description = doc.get("description") ?? "";
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 128 ||
    typeof description !== "string" ||
    description.length > 4096
  )
    throw invalid("请检查 Skill 名称和描述");
  return { name: name.trim(), description };
}
function checkLimit(size: number) {
  if (size > packageLimit)
    throw new ModelError(413, "Skill 包压缩前后均须小于等于 50 MiB");
}
export async function encodePackage(pack: SkillPackage) {
  const { name } = metadata(pack.markdown);
  const zip = new JSZip();
  const folder = name.replace(/[^\p{L}\p{N}_-]+/gu, "-") || "skill";
  zip.file(folder + "/SKILL.md", pack.markdown);
  let size = Buffer.byteLength(pack.markdown);
  for (const [path, bytes] of pack.files) {
    safePath(path);
    size += bytes.length;
    checkLimit(size);
    zip.file(folder + "/" + path, bytes, { createFolders: false });
  }
  if (pack.files.size > 1000) throw invalid("每个 Skill 最多包含 1000 个资源");
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 3 },
  });
  checkLimit(bytes.length);
  return bytes;
}
export async function decodePackages(input: Buffer): Promise<SkillPackage[]> {
  checkLimit(input.length);
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(input);
  } catch {
    throw invalid("ZIP 无效或格式不受支持");
  }
  const entries = Object.values(archive.files);
  if (entries.length > 3000) throw invalid("ZIP 内文件数量超过限制");
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    const path = entry.name.replace(/\/$/, "");
    safePath(path);
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)
      throw invalid("ZIP 包含不安全的路径");
    if (
      entry.dir ||
      path.startsWith("__MACOSX/") ||
      path.split("/").at(-1) === ".DS_Store"
    )
      continue;
    const parts: Buffer[] = [];
    try {
      for await (const part of new Readable().wrap(
        entry.nodeStream("nodebuffer"),
      )) {
        const bytes = Buffer.from(part);
        total += bytes.length;
        checkLimit(total);
        parts.push(bytes);
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw invalid("ZIP 文件内容损坏");
    }
    files.set(path, Buffer.concat(parts));
  }
  const roots = files.has("SKILL.md")
    ? [""]
    : Array.from(files.keys())
        .filter((p) => /^[^/]+\/SKILL\.md$/.test(p))
        .map((p) => p.slice(0, -8));
  if (!roots.length || roots.length > 100)
    throw invalid("请提供含 SKILL.md 的单个 Skill 或一级目录包");
  if (
    Array.from(files.keys()).some(
      (p) => !roots.some((root) => p.startsWith(root)),
    )
  )
    throw invalid("ZIP 中有不属于任何 Skill 的文件");
  return roots.map((root) => {
    const md = files.get(root + "SKILL.md")!;
    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(md);
    } catch {
      throw invalid("SKILL.md 必须使用 UTF-8");
    }
    metadata(markdown);
    const resources = new Map(
      [...files]
        .filter(([p]) => p.startsWith(root) && p !== root + "SKILL.md")
        .map(([p, b]) => [p.slice(root.length), b]),
    );
    return { markdown, files: resources };
  });
}
