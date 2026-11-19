import { local, jsonBody } from "@/server/capabilities/base";
import { createSession } from "@/server/sandbox/store";
export const runtime = "nodejs";
export function POST(req: Request) {
  return local(req, async () =>
    Response.json(
      { data: await createSession(await jsonBody(req)) },
      { status: 201 },
    ),
  );
}
