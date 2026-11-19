import { z } from "zod";
import { ModelError } from "../capabilities/base";
import { run } from "./runner";
import { loadSession, saveWorkspace, exportFiles } from "./store";
import { Workspace, relativePath, entrySchema, quota } from "./workspace";

const session = { sessionId: z.uuid() };
const code = z
  .object({
    code: z.string().min(1),
    variables: z.record(z.string(), z.json()).default({}),
    timeout: z.int().min(1).max(60).default(15),
  })
  .strict();
export const sandboxSchemas = {
  sandboxReadFile: z
    .object({
      ...session,
      path: relativePath,
      startLine: z.int().positive().optional(),
      endLine: z.int().positive().optional(),
    })
    .strict(),
  sandboxWriteFile: z
    .object({ ...session, path: relativePath, content: z.string() })
    .strict(),
  sandboxEditFile: z
    .object({
      ...session,
      entries: z
        .array(
          z
            .object({
              path: relativePath,
              oldContent: z.string().min(1),
              newContent: z.string(),
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict(),
  sandboxSearch: z
    .object({
      ...session,
      pattern: z.string().min(1).max(200),
      path: z.union([relativePath, z.literal(".")]).default("."),
    })
    .strict(),
  sandboxGetFileUrl: z
    .object({ ...session, paths: z.array(relativePath).min(1).max(20) })
    .strict(),
  sandboxShell: z
    .object({
      ...session,
      command: z.string().min(1).max(65536),
      timeout: z.int().min(1).max(60).default(15),
    })
    .strict(),
  runJavaScript: code,
  runPython: code,
};
const shellResult = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.int(),
  entries: z.array(entrySchema).max(512),
});
export async function sandboxNode(
  name: keyof typeof sandboxSchemas,
  input: unknown,
) {
  if (name === "runJavaScript" || name === "runPython")
    return run({ kind: name, ...code.parse(input) });
  const row = await loadSession(z.object(session).parse(input).sessionId);
  const tree = new Workspace(row.files);
  switch (name) {
    case "sandboxReadFile": {
      const {
        path,
        startLine = 1,
        endLine,
      } = sandboxSchemas[name].parse(input);
      if (endLine !== undefined && startLine > endLine)
        throw new ModelError(400, "起始行大于结束行");
      const lines = tree
        .file(path)
        .toString()
        .split(/\r\n|\r|\n/);
      const end = Math.min(endLine ?? lines.length, lines.length);
      return {
        path,
        startLine,
        endLine: end,
        totalLines: lines.length,
        content: lines.slice(startLine - 1, end).join("\n"),
      };
    }
    case "sandboxWriteFile": {
      const { path, content } = sandboxSchemas[name].parse(input);
      tree.put(path, Buffer.from(content).toString("base64"));
      await saveWorkspace(row, tree);
      return { path, bytes: Buffer.byteLength(content) };
    }
    case "sandboxEditFile": {
      const { entries } = sandboxSchemas[name].parse(input);
      for (const e of entries) {
        const before = tree.file(e.path).toString();
        if (!before.includes(e.oldContent))
          throw new ModelError(409, "原文不匹配：" + e.path);
        const growth =
          Buffer.byteLength(e.newContent) - Buffer.byteLength(e.oldContent);
        if (growth > 0) {
          let size = Buffer.byteLength(before);
          let at = before.indexOf(e.oldContent);
          while (at >= 0) {
            size += growth;
            if (size > quota) throw new ModelError(413, "编辑结果超过容量");
            at = before.indexOf(e.oldContent, at + e.oldContent.length);
          }
        }
        tree.put(
          e.path,
          Buffer.from(
            before.replaceAll(e.oldContent, () => e.newContent),
          ).toString("base64"),
        );
        tree.entries();
      }
      await saveWorkspace(row, tree);
      return { paths: [...new Set(entries.map((e) => e.path))] };
    }
    case "sandboxSearch": {
      const { pattern, path } = sandboxSchemas[name].parse(input);
      return { paths: tree.search(pattern, path) };
    }
    case "sandboxGetFileUrl":
      return exportFiles(tree, sandboxSchemas[name].parse(input).paths);
    case "sandboxShell": {
      if (
        row.mode === "workspace-write" ||
        process.env.WORKFLOW_SANDBOX_MODE === "workspace-write"
      )
        return {
          exitCode: -1,
          stdout: "",
          stderr: "workspace-write 已禁止执行命令",
        };
      const { command, timeout } = sandboxSchemas[name].parse(input);
      const { entries, ...result } = shellResult.parse(
        await run(
          { kind: name, command, timeout, entries: tree.entries() },
          row._id,
        ),
      );
      await saveWorkspace(row, new Workspace(entries));
      return result;
    }
  }
}
