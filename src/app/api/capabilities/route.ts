import { local } from "@/server/capabilities/base";
import { capabilities } from "@/server/capabilities/catalog";
export function GET(req: Request) {
  return local(req, async () => Response.json({ data: capabilities() }));
}
