import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { database } from "../model-config/repository";
import { ModelError } from "../capabilities/base";
import {
  decodePackages,
  encodePackage,
  metadata,
  type SkillPackage,
} from "./package";
import type { SkillDetail, SkillSummary, SkillVersion } from "../../lib/skills";

type Row = {
  _id: string;
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  draft: string;
  active: number | null;
  history: SkillVersion[];
};
const collection = async () =>
  (await database()).collection<Row>("workflow16080_skills");
function location(id: string, file?: string) {
  const root = process.env.WORKFLOW_SKILL_DIR || ".workflow-data/skills";
  const dir = path.join(/* turbopackIgnore: true */ root, z.uuid().parse(id));
  return file ? path.join(dir, z.uuid().parse(file) + ".zip") : dir;
}
function summary(row: Row): SkillSummary {
  return {
    id: row._id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    updatedAt: row.updatedAt,
    active: row.active,
    versions: row.history.length,
    dirty:
      row.history.find((v) => v.number === row.active)?.archive !== row.draft,
  };
}
export async function listSkills() {
  return (
    await (await collection()).find().sort({ updatedAt: -1 }).toArray()
  ).map(summary);
}
export async function getSkill(id: string) {
  const row = await (await collection()).findOne({ _id: z.uuid().parse(id) });
  if (!row) throw new ModelError(404, "Skill 不存在");
  return row;
}
async function writeArchive(id: string, pack: SkillPackage) {
  const bytes = await encodePackage(pack);
  const file = randomUUID();
  await mkdir(location(id), { recursive: true, mode: 0o700 });
  await writeFile(location(id, file), bytes, { flag: "wx", mode: 0o600 });
  return file;
}
export async function archive(row: Row, version?: number) {
  const key =
    version === undefined
      ? row.draft
      : row.history.find((v) => v.number === version)?.archive;
  if (!key) throw new ModelError(404, "版本不存在");
  try {
    return await readFile(location(row._id, key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ModelError(409, "版本包不可用，请刷新");
    throw error;
  }
}
export async function content(row: Row, version?: number) {
  return (await decodePackages(await archive(row, version)))[0];
}
function detail(row: Row, pack: SkillPackage): SkillDetail {
  return {
    ...summary(row),
    markdown: pack.markdown,
    resources: [...pack.files].map(([path, b]) => ({ path, size: b.length })),
    history: row.history.map(({ number, at }) => ({ number, at })),
  };
}
export async function readSkill(id: string) {
  const row = await getSkill(id);
  return detail(row, await content(row));
}
export async function createSkills(packs: SkillPackage[]) {
  const col = await collection();
  const rows: Row[] = [];
  const dirs: string[] = [];
  try {
    for (const pack of packs) {
      const id = randomUUID();
      dirs.push(id);
      rows.push({
        _id: id,
        ...metadata(pack.markdown),
        revision: 1,
        updatedAt: new Date().toISOString(),
        draft: await writeArchive(id, pack),
        active: null,
        history: [],
      });
    }
  } catch (error) {
    await Promise.allSettled(
      dirs.map((id) => rm(location(id), { recursive: true, force: true })),
    );
    throw error;
  }
  // All packages are validated and durable before their metadata is exposed.
  try {
    await col.insertMany(rows);
  } catch (error) {
    // On a partial bulk insert, withdraw this import before removing its archives.
    await col.deleteMany({ _id: { $in: dirs } });
    await Promise.allSettled(
      dirs.map((id) => rm(location(id), { recursive: true, force: true })),
    );
    throw error;
  }
  return rows.map(summary);
}
const conflict = () =>
  new ModelError(409, "Skill 已有更新，请重新打开后再操作");
export async function checked(id: string, revision: number) {
  const row = await getSkill(id);
  if (row.revision !== revision) throw conflict();
  return row;
}
async function update(
  row: Row,
  fields: Partial<Omit<Row, "_id" | "revision">>,
) {
  const next = await (
    await collection()
  ).findOneAndUpdate(
    { _id: row._id, revision: row.revision },
    {
      $set: { ...fields, updatedAt: new Date().toISOString() },
      $inc: { revision: 1 },
    },
    { returnDocument: "after" },
  );
  if (!next) throw conflict();
  return next;
}
export async function saveDraft(row: Row, pack: SkillPackage) {
  const fields = metadata(pack.markdown);
  const draft = await writeArchive(row._id, pack);
  let next: Row;
  try {
    next = await update(row, { ...fields, draft });
  } catch (error) {
    if (error instanceof ModelError && error.status === 409)
      await rm(location(row._id, draft), { force: true });
    throw error;
  }
  if (!next.history.some((v) => v.archive === row.draft))
    await rm(location(row._id, row.draft), { force: true });
  return detail(next, pack);
}
export async function publish(row: Row) {
  const prior = row.history.find((v) => v.archive === row.draft);
  const version = prior ?? {
    number: row.history.length + 1,
    archive: row.draft,
    at: new Date().toISOString(),
  };
  return summary(
    await update(row, {
      active: version.number,
      history: prior ? row.history : [...row.history, version],
    }),
  );
}
export async function activate(row: Row, number: number) {
  if (!row.history.some((v) => v.number === number))
    throw new ModelError(404, "版本不存在");
  return summary(await update(row, { active: number }));
}
export async function removeSkill(row: Row) {
  const res = await (
    await collection()
  ).deleteOne({ _id: row._id, revision: row.revision });
  if (!res.deletedCount) throw conflict();
  await rm(location(row._id), { recursive: true, force: true });
}
