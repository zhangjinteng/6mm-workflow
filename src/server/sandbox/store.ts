import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { database } from "../model-config/repository";
import { ModelError } from "../capabilities/base";
import { getFile } from "../capabilities/files";
import { Workspace, quota, type Entry } from "./workspace";

type Session = {
  _id: string;
  mode: "workspace-write" | "isolated-shell";
  expiresAt: Date;
  version: number;
  files: Entry[];
};
type Artifact = {
  _id: string;
  expiresAt: Date;
  files: { token: string; filename: string; data: string }[];
};
const sessions = async () =>
  (await database()).collection<Session>("workflow16080_sandbox_sessions");
const artifacts = async () =>
  (await database()).collection<Artifact>("workflow16080_sandbox_artifacts");
let indexes: Promise<unknown> | undefined;
async function prepare() {
  indexes ??= Promise.all([
    sessions().then((c) =>
      c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ),
    artifacts().then((c) =>
      c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ),
    artifacts().then((c) =>
      c.createIndex({ "files.token": 1 }, { unique: true }),
    ),
  ]).catch((error) => {
    indexes = undefined;
    throw error;
  });
  await indexes;
}
const createSchema = z
  .object({
    fileIds: z.array(z.uuid()).max(20).default([]),
    mode: z.enum(["workspace-write", "isolated-shell"]).optional(),
  })
  .strict();
const info = (s: Pick<Session, "_id" | "mode" | "expiresAt">) => ({
  sessionId: s._id,
  mode: s.mode,
  expiresAt: s.expiresAt,
});
export async function createSession(body: unknown) {
  const p = createSchema.parse(body);
  const maximum = process.env.WORKFLOW_SANDBOX_MODE ?? "isolated-shell";
  if (!["isolated-shell", "workspace-write"].includes(maximum))
    throw new ModelError(503, "沙箱权限配置错误");
  if (maximum === "workspace-write" && p.mode === "isolated-shell")
    throw new ModelError(403, "服务端已禁用 Shell");
  const tree = new Workspace([]);
  const attachments = [];
  let total = 0;
  for (const id of new Set(p.fileIds)) {
    const f = await getFile(id);
    total += f.meta.size;
    if (total > quota) throw new ModelError(413, "附件超过工作目录容量");
    const path = "user_files/" + id + "/" + f.meta.name;
    tree.put(path, (await f.bytes()).toString("base64"));
    attachments.push({ fileId: id, path });
  }
  const row: Session = {
    _id: randomUUID(),
    mode:
      p.mode ?? (maximum === "workspace-write" ? maximum : "isolated-shell"),
    version: 0,
    expiresAt: new Date(Date.now() + 2 * 3600000),
    files: tree.entries(),
  };
  await prepare();
  await (await sessions()).insertOne(row);
  return { ...info(row), attachments };
}
const live = (id: string) => ({
  _id: z.uuid().parse(id),
  expiresAt: { $gt: new Date() },
});
export async function loadSession(id: string) {
  const row = await (await sessions()).findOne(live(id));
  if (!row) throw new ModelError(404, "会话已关闭、过期或不存在");
  return row;
}
export async function sessionInfo(id: string) {
  const row = await (
    await sessions()
  ).findOne(live(id), { projection: { files: 0 } });
  if (!row) throw new ModelError(404, "会话已关闭、过期或不存在");
  return info(row);
}
export async function saveWorkspace(row: Session, tree: Workspace) {
  const result = await (
    await sessions()
  ).updateOne(
    { ...live(row._id), version: row.version },
    { $set: { files: tree.entries() }, $inc: { version: 1 } },
  );
  if (!result.matchedCount)
    throw new ModelError(409, "会话已关闭、过期或被并发修改");
}
export async function closeSession(id: string) {
  await (await sessions()).deleteOne({ _id: z.uuid().parse(id) });
}
export async function exportFiles(tree: Workspace, paths: string[]) {
  const expiresAt = new Date(Date.now() + 2 * 3600000);
  const files = [...new Set(paths)].map((path) => ({
    token: randomUUID(),
    filename: posix.basename(path),
    data: tree.file(path).toString("base64"),
  }));
  await (await artifacts()).insertOne({ _id: randomUUID(), expiresAt, files });
  return {
    files: files.map((f) => ({
      filename: f.filename,
      fileUrl: "/api/sandbox/artifacts/" + f.token,
      expiresAt,
    })),
  };
}
export async function download(token: string) {
  const row = await (
    await artifacts()
  ).findOne(
    { "files.token": z.uuid().parse(token), expiresAt: { $gt: new Date() } },
    { projection: { files: { $elemMatch: { token } } } },
  );
  if (!row) throw new ModelError(404, "下载链接不存在或已过期");
  const file = row.files[0];
  return new Response(Buffer.from(file.data, "base64"), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
    },
  });
}
