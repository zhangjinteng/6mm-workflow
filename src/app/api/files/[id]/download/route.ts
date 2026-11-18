import { local } from "@/server/capabilities/base";
import { getFile } from "@/server/capabilities/files";
export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return local(req, async () => {
    const file = await getFile((await ctx.params).id);
    return new Response(new Uint8Array(await file.bytes()), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          "attachment; filename*=UTF-8''" + encodeURIComponent(file.meta.name),
      },
    });
  });
}
