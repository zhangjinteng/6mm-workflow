import { z } from "zod";
import { local, jsonBody } from "@/server/capabilities/base";
import { decideShellJob, shellJob } from "@/server/host-shell/service";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, ctx: Context) { return local(req, async () => Response.json({ data: await shellJob((await ctx.params).id) })); }
export function POST(req: Request, ctx: Context) {
  return local(req, async () => {
    const p = z.object({ decision: z.enum(["approve", "deny", "cancel"]), confirmed: z.literal(true) }).strict().parse(await jsonBody(req));
    const job = await decideShellJob((await ctx.params).id, p.decision);
    if (job.runId) await (await import("@/server/agent/service")).status(job.runId);
    return Response.json({ data: job });
  });
}
