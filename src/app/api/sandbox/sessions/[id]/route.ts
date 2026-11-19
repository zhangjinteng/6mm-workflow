import { local } from "@/server/capabilities/base";
import { sessionInfo, closeSession } from "@/server/sandbox/store";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, ctx: Context) {
  return local(req, async () =>
    Response.json({ data: await sessionInfo((await ctx.params).id) }),
  );
}
export function DELETE(req: Request, ctx: Context) {
  return local(req, async () => {
    await closeSession((await ctx.params).id);
    return new Response(null, { status: 204 });
  });
}
