import { posix } from "node:path";
import { z } from "zod";
import { ModelError } from "../capabilities/base";

export const quota = 8 * 1024 * 1024;
export const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !Array.from(p).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) &&
      p
        .split("/")
        .every((s) => s && s !== "." && s !== ".." && s.length <= 200),
    "需要会话内的相对路径",
  );
export const entrySchema = z.object({
  path: relativePath,
  data: z.string().nullable(),
});
export type Entry = z.infer<typeof entrySchema>; // null denotes a directory.
export class Workspace {
  private tree = new Map<string, string | null>();
  constructor(entries: Entry[]) {
    for (const entry of entries) this.put(entry.path, entry.data);
  }
  put(path: string, data: string | null) {
    relativePath.parse(path);
    const parent = posix.dirname(path);
    if (parent !== ".") {
      if (!this.tree.has(parent)) this.put(parent, null);
      if (this.tree.get(parent) !== null)
        throw new ModelError(409, "父路径是文件");
    }
    if (
      this.tree.has(path) &&
      (this.tree.get(path) === null) !== (data === null)
    )
      throw new ModelError(409, "文件和目录路径冲突");
    this.tree.set(path, data);
  }
  file(path: string) {
    const value = this.tree.get(path);
    if (typeof value !== "string")
      throw new ModelError(404, "会话内找不到该文件");
    return Buffer.from(value, "base64");
  }
  entries(): Entry[] {
    const rows = Array.from(this.tree, ([path, data]) => ({ path, data }));
    if (
      rows.length > 512 ||
      rows.reduce(
        (sum, e) => sum + (e.data ? Buffer.byteLength(e.data, "base64") : 0),
        0,
      ) > quota
    )
      throw new ModelError(413, "工作目录限 512 项、8 MiB");
    return rows;
  }
  search(pattern: string, folder: string) {
    if (folder !== "." && !this.tree.has(folder))
      throw new ModelError(404, "搜索路径不存在");
    // Shell-style basename matching, bounded even for repeated wildcards.
    const matches = (name: string) => {
      let pos = 0,
        token = 0,
        star = -1,
        retry = 0;
      while (pos < name.length) {
        if (
          pattern[token] !== "*" &&
          (pattern[token] === "?" || pattern[token] === name[pos])
        ) {
          pos++;
          token++;
        } else if (pattern[token] === "*") {
          star = token++;
          retry = pos;
        } else if (star >= 0) {
          token = star + 1;
          pos = ++retry;
        } else return false;
      }
      while (pattern[token] === "*") token++;
      return token === pattern.length;
    };
    return [...this.tree.keys()]
      .filter(
        (p) =>
          (folder === "." || p === folder || p.startsWith(folder + "/")) &&
          matches(posix.basename(p)),
      )
      .sort();
  }
}
