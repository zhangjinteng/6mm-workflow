import { z } from "zod";
import { local } from "@/server/capabilities/base";
import { cancel } from "@/server/agent/store";

export const runtime = "nodejs";
export function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return local(req, async () =>
    Response.json({ data: await cancel(z.uuid().parse((await params).runId)) }),
  );
}
