import { local, jsonBody } from "@/server/capabilities/base";
import { getShellPolicy, setShellPolicy } from "@/server/host-shell/service";
export const runtime = "nodejs";
export function GET(req: Request) { return local(req, async () => Response.json({ data: await getShellPolicy() })); }
export function PUT(req: Request) { return local(req, async () => Response.json({ data: await setShellPolicy(await jsonBody(req)) })); }
