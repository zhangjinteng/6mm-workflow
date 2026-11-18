import { local, jsonBody } from "@/server/capabilities/base";
import { manageIntegration } from "@/server/capabilities/integrations";
function handle(r: Request, ctx: { params: Promise<{ id: string }> }) {
  return local(r, async () =>
    Response.json({
      data: await manageIntegration(
        (await ctx.params).id,
        r.method,
        r.method === "PATCH" ? await jsonBody(r) : undefined,
      ),
    }),
  );
}
export { handle as GET, handle as PATCH, handle as DELETE };
