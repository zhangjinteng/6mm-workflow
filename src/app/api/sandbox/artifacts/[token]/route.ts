import { local } from "@/server/capabilities/base";
import { download } from "@/server/sandbox/store";
export const runtime = "nodejs";
export function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return local(req, async () => download((await ctx.params).token));
}
