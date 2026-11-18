import { local, ModelError } from "@/server/capabilities/base";
import { capabilities } from "@/server/capabilities/catalog";
export function GET(
  req: Request,
  context: { params: Promise<{ name: string }> },
) {
  return local(req, async () => {
    const { name } = await context.params;
    const entry = capabilities().find((c) => c.name === name);
    if (!entry) throw new ModelError(404, "未知能力");
    return Response.json({ data: entry });
  });
}
