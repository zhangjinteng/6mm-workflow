import {
  boundedBody,
  local,
  uploadLimit,
  ModelError,
} from "@/server/capabilities/base";
import { saveFile } from "@/server/capabilities/files";
export function POST(request: Request) {
  return local(request, async () => {
    const bytes = await boundedBody(request, uploadLimit);
    const type =
      request.headers.get("content-type") || "application/octet-stream";
    if (type.startsWith("multipart/form-data")) {
      let form: FormData;
      try {
        form = await new Response(bytes, {
          headers: { "Content-Type": type },
        }).formData();
      } catch {
        throw new ModelError(400, "multipart 无效");
      }
      const file = form.get("file");
      if (!(file instanceof Blob) || !("name" in file))
        throw new ModelError(400, "缺少 file");
      return Response.json(
        {
          data: await saveFile(
            Buffer.from(await file.arrayBuffer()),
            String(file.name),
            file.type,
          ),
        },
        { status: 201 },
      );
    }
    const name = new URL(request.url).searchParams.get("name");
    if (!name) throw new ModelError(400, "缺少文件名 name");
    return Response.json(
      { data: await saveFile(bytes, name, type) },
      { status: 201 },
    );
  });
}
