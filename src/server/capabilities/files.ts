import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { z } from "zod";
import { fileId, ModelError, uploadLimit } from "./base";

const root = () =>
  process.env.WORKFLOW_FILE_DIR ||
  path.join(process.cwd(), ".workflow-data", "files");
export async function saveFile(bytes: Buffer, name: string, mime: string) {
  if (bytes.length > uploadLimit) throw new ModelError(413, "文件过大");
  const id = randomUUID();
  const metadata = {
    id,
    name: z.string().min(1).max(255).parse(path.basename(name)),
    mime,
    size: bytes.length,
  };
  const pending = path.join(/*turbopackIgnore: true*/ root(), "." + id);
  await mkdir(root(), { recursive: true, mode: 0o700 });
  await mkdir(pending, { mode: 0o700 });
  try {
    await writeFile(path.join(pending, "body"), bytes, { mode: 0o600 });
    await writeFile(path.join(pending, "meta.json"), JSON.stringify(metadata), {
      mode: 0o600,
    });
    await rename(pending, path.join(/*turbopackIgnore: true*/ root(), id));
  } catch (e) {
    await rm(pending, { recursive: true, force: true });
    throw e;
  }
  return metadata;
}
export async function getFile(id: string) {
  const dir = path.join(/*turbopackIgnore: true*/ root(), fileId.parse(id));
  try {
    const meta = JSON.parse(
      await readFile(path.join(dir, "meta.json"), "utf8"),
    ) as Awaited<ReturnType<typeof saveFile>>;
    return {
      meta,
      bytes: () => readFile(path.join(dir, "body")),
      remove: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new ModelError(404, "文件不存在");
    throw e;
  }
}
