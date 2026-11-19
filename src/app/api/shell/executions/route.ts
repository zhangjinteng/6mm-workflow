import { z } from "zod";
import { local, jsonBody } from "@/server/capabilities/base";
import { listShellJobs, submitHostCommand } from "@/server/host-shell/service";
import { hostCommandSchema } from "@/lib/host-shell";
export const runtime = "nodejs";
export function GET(req: Request) { return local(req, async () => Response.json({ data: await listShellJobs() })); }
export function POST(req: Request) {
  return local(req, async () => {
    const { requestId, policyRevision, ...input } = hostCommandSchema.extend({ requestId: z.uuid(), policyRevision: z.int().nonnegative() }).parse(await jsonBody(req));
    return Response.json({ data: await submitHostCommand(input, { requestId, policyRevision }) });
  });
}
