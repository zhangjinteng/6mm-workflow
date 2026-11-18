import { local, jsonBody } from "@/server/capabilities/base";
import {
  createIntegration,
  listIntegrations,
} from "@/server/capabilities/integrations";
export function GET(r: Request) {
  return local(r, async () =>
    Response.json({ data: await listIntegrations() }),
  );
}
export function POST(r: Request) {
  return local(r, async () =>
    Response.json(
      { data: await createIntegration(await jsonBody(r)) },
      { status: 201 },
    ),
  );
}
