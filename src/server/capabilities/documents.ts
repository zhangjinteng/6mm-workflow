import path from "node:path";
import { z } from "zod";
import { fileId, ModelError } from "./base";
import { getFile, saveFile } from "./files";
import { resolveIntegration } from "./integrations";
import { enhancedPdf } from "./providers";
import { runWorker } from "./worker";

const formats = {
  parseTxt: "txt",
  parseMarkdown: "md",
  parseCsv: "csv",
  parseHtml: "html",
  parsePdf: "pdf",
  parseDocx: "docx",
  parsePptx: "pptx",
  parseXlsx: "xlsx",
} as const;
const providers = {
  parsePdfCustom: "customPdf",
  parsePdfTextIn: "textin",
  parsePdfDoc2x: "doc2x",
} as const;
const fileParams = z
  .object({ fileId, encoding: z.string().max(40).optional() })
  .strict();
const pdfParams = z
  .object({ fileId, integrationId: z.uuid().optional() })
  .strict();
const selectParams = fileParams.extend({
  customPdfParse: z.boolean().default(false),
});
const chunkOptions = {
  chunkSize: z.number().int().min(8).max(32000).default(1000),
  maxSize: z.number().int().min(8).max(64000).optional(),
  overlapRatio: z.number().min(0).max(0.5).optional(),
  paragraphChunkDeep: z.number().int().min(0).max(10).optional(),
  paragraphChunkMinSize: z.number().int().min(0).max(32000).optional(),
};
export const documentSchemas: Record<string, z.ZodType> = {
  ...Object.fromEntries(Object.keys(formats).map((k) => [k, fileParams])),
  ...Object.fromEntries(Object.keys(providers).map((k) => [k, pdfParams])),
  parseFile: selectParams,
  previewFileChunks: selectParams.extend({
    ...chunkOptions,
    limit: z.number().int().min(1).max(200).default(10),
  }),
  textToChunks: z.object({ text: z.string(), ...chunkOptions }).strict(),
  htmlToMarkdown: z.object({ html: z.string() }).strict(),
  readFiles: z
    .object({
      fileIds: z.array(fileId).min(1).max(20),
      customPdfParse: z.boolean().default(false),
    })
    .strict(),
};
type Parsed = {
  rawText: string;
  formatText?: string;
  pages?: number;
  imageList?: { uuid: string; mime: string; base64: string }[];
};
async function normalize(parsed: Parsed, parser: string, created: string[]) {
  let text = parsed.formatText ?? parsed.rawText;
  const images = [];
  for (const image of parsed.imageList || []) {
    const file = await saveFile(
      Buffer.from(image.base64, "base64"),
      "image." + (image.mime.split("/")[1] || "bin"),
      image.mime,
    );
    created.push(file.id);
    const url = "/api/files/" + file.id + "/download";
    text = text.replaceAll(image.uuid, url);
    images.push({ id: file.id, url, mime: file.mime });
  }
  return {
    text,
    parser,
    images,
    ...(parsed.pages !== undefined ? { pages: parsed.pages } : {}),
  };
}
async function parse(
  file: string,
  created: string[],
  kind?: string,
  encoding?: string,
  custom = false,
  integrationId?: string,
) {
  const f = await getFile(file);
  const extension = path.extname(f.meta.name).slice(1).toLowerCase();
  let provider = Object.values(providers).find((p) => p === kind);
  let connection = provider
    ? await resolveIntegration(provider, integrationId)
    : null;
  if (!provider && (!kind || kind === "pdf") && extension === "pdf" && custom) {
    for (const candidate of Object.values(providers)) {
      connection = await resolveIntegration(candidate, undefined, true);
      if (connection) {
        provider = candidate;
        break;
      }
    }
  }
  const expected = provider ? "pdf" : kind || extension;
  if (
    extension !== expected ||
    !Object.values(formats).some((f) => f === expected)
  )
    throw new ModelError(422, "文件类型与解析器不匹配");
  const bytes = await f.bytes();
  if (connection) {
    const pdf = await enhancedPdf(connection, bytes);
    const parsed = await runWorker("pdfMarkdown", { markdown: pdf.rawText });
    return normalize(
      {
        ...parsed,
        pages: pdf.pages,
        imageList: [
          ...(parsed.imageList ?? []),
          ...("imageList" in pdf ? (pdf.imageList ?? []) : []),
        ],
      },
      connection.kind,
      created,
    );
  }
  const parsed = await runWorker(expected, { encoding }, bytes);
  return normalize(parsed, provider || expected, created);
}
export async function documentNode(name: string, input: unknown) {
  const created: string[] = [];
  try {
    return await processDocument(name, input, created);
  } catch (error) {
    await Promise.allSettled(
      created.map(async (id) => (await getFile(id)).remove()),
    );
    throw error;
  }
}
async function processDocument(
  name: string,
  input: unknown,
  created: string[],
) {
  if (name === "readFiles") {
    const p = z
      .object({ fileIds: z.array(fileId), customPdfParse: z.boolean() })
      .parse(input);
    const files = [];
    for (const id of p.fileIds)
      files.push({
        fileId: id,
        ...(await parse(id, created, undefined, undefined, p.customPdfParse)),
      });
    return { files };
  }
  if (name === "textToChunks")
    return runWorker(
      "chunks",
      z.object({ text: z.string(), ...chunkOptions }).parse(input),
    );
  if (name === "htmlToMarkdown")
    return normalize(
      await runWorker("markdown", z.object({ html: z.string() }).parse(input)),
      "html",
      created,
    );
  const p = z
    .object({
      fileId,
      encoding: z.string().optional(),
      customPdfParse: z.boolean().optional(),
      integrationId: z.uuid().optional(),
    })
    .parse(input);
  const kind =
    formats[name as keyof typeof formats] ||
    providers[name as keyof typeof providers];
  const result = await parse(
    p.fileId,
    created,
    kind,
    p.encoding,
    p.customPdfParse,
    p.integrationId,
  );
  if (name === "previewFileChunks") {
    const options = z
      .object({ ...chunkOptions, limit: z.number() })
      .parse(input);
    const { chunks, chars } = await runWorker<{
      chunks: string[];
      chars: number;
    }>("chunks", { ...options, text: result.text });
    return {
      chunks: chunks.slice(0, options.limit),
      images: result.images,
      total: chunks.length,
      chars,
    };
  }
  return result;
}
