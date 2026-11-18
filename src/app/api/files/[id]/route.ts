import { local } from "@/server/capabilities/base";
import { getFile } from "@/server/capabilities/files";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, ctx: Context) {
  return local(req, async () =>
    Response.json({ data: (await getFile((await ctx.params).id)).meta }),
  );
}
export function DELETE(req: Request, ctx: Context) {
  return local(req, async () => {
    await (await getFile((await ctx.params).id)).remove();
    return new Response(null, { status: 204 });
  });
}
