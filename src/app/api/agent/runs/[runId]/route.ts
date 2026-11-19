import { local } from "@/server/capabilities/base";
import { status } from "@/server/agent/service";

export const runtime = "nodejs";
export function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return local(req, async () =>
    Response.json({ data: await status((await params).runId) }),
  );
}
