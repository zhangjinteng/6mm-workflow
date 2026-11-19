import { z } from "zod";
import { local, jsonBody, boundedBody, ModelError } from "../capabilities/base";
import {
  activate,
  archive,
  checked,
  content,
  createSkills,
  getSkill,
  listSkills,
  publish,
  readSkill,
  removeSkill,
  saveDraft,
} from "./repository";
import { decodePackages, packageLimit, safePath } from "./package";

type Context = { params: Promise<{ id: string }> };
const revision = z.number().int().positive();
const queryRevision = (req: Request) =>
  z.coerce
    .number()
    .int()
    .positive()
    .parse(new URL(req.url).searchParams.get("revision"));
const ok = (data: unknown, status = 200) => Response.json({ data }, { status });
export const list = (req: Request) =>
  local(req, async () => ok(await listSkills()));
export const create = (req: Request) =>
  local(req, async () => {
    const { markdown } = z
      .object({ markdown: z.string() })
      .parse(await jsonBody(req));
    return ok((await createSkills([{ markdown, files: new Map() }]))[0], 201);
  });
export const importZip = (req: Request) =>
  local(req, async () =>
    ok(
      await createSkills(
        await decodePackages(await boundedBody(req, packageLimit)),
      ),
      201,
    ),
  );
export const get = (req: Request, ctx: Context) =>
  local(req, async () => ok(await readSkill((await ctx.params).id)));
export const edit = (req: Request, ctx: Context) =>
  local(req, async () => {
    const p = z
      .object({ revision, markdown: z.string() })
      .parse(await jsonBody(req));
    const row = await checked((await ctx.params).id, p.revision);
    const pack = await content(row);
    pack.markdown = p.markdown;
    return ok(await saveDraft(row, pack));
  });
export const remove = (req: Request, ctx: Context) =>
  local(req, async () => {
    await removeSkill(await checked((await ctx.params).id, queryRevision(req)));
    return new Response(null, { status: 204 });
  });
export const version = (req: Request, ctx: Context) =>
  local(req, async () => {
    const p = z
      .object({ revision, number: revision.optional() })
      .strict()
      .parse(await jsonBody(req));
    const row = await checked((await ctx.params).id, p.revision);
    return ok(p.number ? await activate(row, p.number) : await publish(row));
  });
export const copy = (req: Request, ctx: Context) =>
  local(req, async () =>
    ok(
      (
        await createSkills([
          await content(await getSkill((await ctx.params).id)),
        ])
      )[0],
      201,
    ),
  );
export const exportZip = (req: Request, ctx: Context) =>
  local(req, async () => {
    const row = await getSkill((await ctx.params).id);
    const v = new URL(req.url).searchParams.get("version");
    const bytes = await archive(
      row,
      v === null ? undefined : z.coerce.number().int().positive().parse(v),
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          "attachment; filename*=UTF-8''" +
          encodeURIComponent(row.name.replace(/[/\\]/g, "-") + ".zip"),
      },
    });
  });
export const resource = (req: Request, ctx: Context) =>
  local(req, async () => {
    const id = (await ctx.params).id;
    const path = safePath(new URL(req.url).searchParams.get("path") || "");
    if (path === "SKILL.md")
      throw new ModelError(400, "请在说明编辑器中修改 SKILL.md");
    const row =
      req.method === "GET"
        ? await getSkill(id)
        : await checked(id, queryRevision(req));
    const pack = await content(row);
    if (req.method === "GET") {
      const bytes = pack.files.get(path);
      if (!bytes) throw new ModelError(404, "资源不存在");
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition":
            "attachment; filename*=UTF-8''" +
            encodeURIComponent(path.split("/").at(-1)!),
        },
      });
    }
    if (req.method === "DELETE") {
      if (!pack.files.delete(path)) throw new ModelError(404, "资源不存在");
    } else pack.files.set(path, await boundedBody(req, packageLimit));
    return ok(await saveDraft(row, pack));
  });
