import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { decode, multipart, send } from "./network";
import { resolveIntegration } from "./integrations";
import { ModelError } from "./base";
type Config = NonNullable<Awaited<ReturnType<typeof resolveIntegration>>>;
const object = z.object;
const md = z.string();
function upstream<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ModelError(502, "上游响应结构无效");
  return parsed.data;
}
async function doc2xMarkdown(pages: { md: string }[], transport: typeof send) {
  let text = pages
    .map((p) => p.md)
    .join("\n")
    .replace(/<img\s+src="([^"]+)"[^>]*>/gi, "![img]($1)")
    .replace(
      /<!-- (?:Media|Footnote|Meanless:[\s\S]*?|figureText:[\s\S]*?) -->/g,
      "",
    )
    .replace(/\\[()]/g, "$")
    .replace(/\\[[\]]/g, () => "$$");
  const links = new Set(
    Array.from(
      text.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g),
      (m) => m[1],
    ),
  );
  const imageList: { uuid: string; mime: string; base64: string }[] = [];
  let remaining = 12 * 1024 * 1024;
  for (const link of [...links].slice(0, 16)) {
    if (remaining <= 0) break;
    try {
      const image = await transport(new URL(link), "GET", {}, undefined, 5000);
      if (image.length === 0 || image.length > remaining) continue;
      const head = image.subarray(0, 12);
      const mime = head
        .subarray(0, 8)
        .equals(Buffer.from("89504e470d0a1a0a", "hex"))
        ? "png"
        : head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
          ? "jpeg"
          : head.toString("ascii", 0, 3) === "GIF"
            ? "gif"
            : head.toString("ascii", 8, 12) === "WEBP"
              ? "webp"
              : null;
      if (mime) {
        remaining -= image.length;
        const uuid = randomUUID();
        imageList.push({
          uuid,
          mime: "image/" + mime,
          base64: image.toString("base64"),
        });
        text = text.replaceAll("](" + link + ")", "](" + uuid + ")");
      }
    } catch {
      /* Keep the provider's link if its image is unavailable. */
    }
  }
  return { rawText: text, ...(imageList.length ? { imageList } : {}) };
}
export async function enhancedPdf(
  c: Config,
  bytes: Buffer,
  transport = send,
  pause = () => delay(3000),
) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new ModelError(422, "无效 PDF");
  if (c.kind === "customPdf") {
    const form = await multipart(
      {},
      "file",
      bytes,
      "input.pdf",
      "application/pdf",
    );
    const headers: Record<string, string> = { "Content-Type": form.type };
    if (c.key) headers.Authorization = "Bearer " + c.key;
    const res = decode(
      await transport(new URL(c.url!), "POST", headers, form.body, 600000),
    );
    const data = upstream(
      object({
        markdown: md,
        pages: z.number().int().nonnegative(),
        error: z.union([z.null(), z.literal(false), z.literal("")]).optional(),
      }),
      res,
    );
    return { rawText: data.markdown, pages: data.pages };
  }
  if (c.kind === "textin") {
    const url = new URL("https://api.textin.com/ai/service/v1/pdf_to_markdown");
    url.search = new URLSearchParams({
      get_image: "objects",
      image_output_type: "base64str",
      parse_mode: "auto",
      dpi: "144",
      markdown_details: "1",
      table_flavor: "md",
      paratext_mode: "none",
      page_details: "0",
      remove_watermark: "1",
    }).toString();
    const res = decode(
      await transport(
        url,
        "POST",
        {
          "Content-Type": "application/octet-stream",
          "x-ti-app-id": c.appId!,
          "x-ti-secret-code": c.key!,
        },
        bytes,
        300000,
      ),
    );
    const { result } = upstream(
      object({
        code: z.literal(200),
        result: object({
          markdown: md,
          total_page_number: z.number().optional(),
          pages: z.array(z.unknown()).optional(),
        }),
      }),
      res,
    );
    return {
      rawText: result.markdown,
      pages: result.pages?.length || result.total_page_number || 1,
    };
  }
  const base = "https://v2.doc2x.noedgeai.com/api/v2/parse/";
  const auth = { Authorization: "Bearer " + c.key! };
  const ok = z.enum(["ok", "success"]);
  const { data } = upstream(
    object({ code: ok, data: object({ uid: z.string(), url: z.url() }) }),
    decode(await transport(new URL(base + "preupload"), "POST", auth)),
  );
  await transport(
    new URL(data.url),
    "PUT",
    { "Content-Type": "application/pdf" },
    bytes,
  );
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const url = new URL(base + "status");
    url.searchParams.set("uid", data.uid);
    const res = upstream(
      object({
        code: ok,
        data: object({
          status: z.enum(["processing", "ready", "success", "failed"]),
          result: z.unknown().optional(),
        }),
      }),
      decode(await transport(url, "GET", auth)),
    );
    if (res.data.status === "failed")
      throw new ModelError(502, "Doc2X 解析失败");
    if (res.data.status === "success") {
      const result = upstream(
        object({ pages: z.array(object({ md })) }),
        res.data.result,
      );
      return {
        ...(await doc2xMarkdown(result.pages, transport)),
        pages: result.pages.length,
      };
    }
    await pause();
  }
  throw new ModelError(504, "Doc2X 任务超时");
}
export async function moderate(c: Config, text: string, transport = send) {
  if (!c.url) {
    const match = c.blockedTerms?.some((term) =>
      text.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
    );
    if (!c.blockedTerms?.length) throw new ModelError(503, "审核规则未配置");
    return {
      decision: match ? "reject" : "allow",
      reason: match ? "命中已配置的审核词条" : "",
      provider: "local-rules",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (c.key) headers.Authorization = "Bearer " + c.key;
  const data = upstream(
    object({
      code: z.union([z.literal(0), z.literal(200), z.literal(5000)]),
      message: z.string().optional(),
    }),
    decode(
      await transport(
        new URL(c.url),
        "POST",
        headers,
        Buffer.from(JSON.stringify({ text })),
      ),
    ),
  );
  return {
    decision: data.code === 5000 ? "reject" : "allow",
    reason: data.message || "",
    provider: "http",
  };
}
