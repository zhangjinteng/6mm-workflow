import { parentPort, workerData } from "node:worker_threads";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { readFileRawText } from "./vendor/service/worker/readFile/extension/rawText.js";
import { readCsvRawText } from "./vendor/service/worker/readFile/extension/csv.js";
import { readHtmlRawText } from "./vendor/service/worker/readFile/extension/html.js";
import { html2md } from "./vendor/service/worker/htmlStr2Md/utils.js";
import {
  matchMdImg,
  htmlTable2Md,
} from "./vendor/global/common/string/markdown.js";
import {
  splitText2Chunks,
  CUSTOM_SPLIT_SIGN,
} from "./vendor/global/common/string/textSplitter.js";

async function readOffice(buffer, kind) {
  const archive = await JSZip.loadAsync(buffer);
  const entries = Object.values(archive.files);
  if (
    entries.length > 10000 ||
    entries.reduce((n, e) => n + (e._data?.uncompressedSize || 0), 0) >
      64 * 1024 * 1024
  )
    throw Error("Office 文档解压后超过限制");
  const required = {
    docx: "word/document.xml",
    xlsx: "xl/workbook.xml",
    pptx: "ppt/presentation.xml",
  };
  if (!archive.file(required[kind])) throw Error("Office 格式与文件类型不符");
  if (kind === "docx") {
    const { readDocsFile } = await import(
      "./vendor/service/worker/readFile/extension/docx.js"
    );
    return readDocsFile({ buffer });
  }
  if (kind === "pptx") {
    const slides = entries.filter((e) =>
      /^ppt\/(?:notesSlides\/notesSlide|slides\/slide)\d+\.xml$/.test(e.name),
    );
    if (!slides.some((s) => s.name.startsWith("ppt/slides/")))
      throw Error("缺少幻灯片");
    const slideNumber = (s) => Number(s.name.match(/(\d+)\.xml$/)[1]);
    slides.sort(
      (a, b) =>
        slideNumber(a) - slideNumber(b) ||
        Number(a.name.includes("notesSlides")) -
          Number(b.name.includes("notesSlides")),
    );
    const pages = [];
    for (const slide of slides) {
      const doc = new DOMParser().parseFromString(
        await slide.async("string"),
        "text/xml",
      );
      const lines = Array.from(doc.getElementsByTagName("a:p"))
        .map((p) =>
          Array.from(p.getElementsByTagName("a:t"), (t) => t.textContent).join(
            "",
          ),
        )
        .filter(Boolean);
      pages.push(lines.join("\n"));
    }
    return { rawText: pages.join("\n") };
  }
  const { default: XLSX } = await import("xlsx");
  const book = XLSX.read(buffer, { type: "buffer" });
  const tables = book.SheetNames.map((name) =>
    XLSX.utils.sheet_to_json(book.Sheets[name], {
      header: 1,
      defval: "",
      raw: false,
    }),
  );
  return {
    rawText: tables
      .map((rows) => rows.map((row) => row.join(",")).join("\n"))
      .join("\n"),
    formatText: tables
      .filter((rows) => rows.length)
      .map(([header, ...rows]) =>
        [header, header.map(() => "---"), ...rows]
          .map(
            (row) =>
              "| " +
              row
                .map((cell) => String(cell).replaceAll("\n", "\\n"))
                .join(" | ") +
              " |",
          )
          .join("\n"),
      )
      .join(CUSTOM_SPLIT_SIGN),
  };
}

async function execute({ kind, bytes, params }) {
  if (kind === "pdfMarkdown") {
    const { text, imageList } = matchMdImg(htmlTable2Md(params.markdown));
    return { rawText: text, imageList };
  }
  if (kind === "chunks") return splitText2Chunks(params);
  if (kind === "markdown") return html2md(params.html);
  const buffer = Buffer.from(bytes);
  if (["docx", "xlsx", "pptx"].includes(kind)) return readOffice(buffer, kind);
  if (kind === "pdf") {
    if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      throw Error("无效 PDF");
    const { readPdfFile } = await import(
      "./vendor/service/worker/readFile/extension/pdf.js"
    );
    return readPdfFile({ buffer });
  }
  const reader = {
    txt: readFileRawText,
    md: readFileRawText,
    html: readHtmlRawText,
    csv: readCsvRawText,
  }[kind];
  return reader({ buffer, encoding: params.encoding || "utf8" });
}
try {
  parentPort.postMessage({ result: await execute(workerData) });
} catch {
  parentPort.postMessage({ error: "文件或文本解析失败，请检查格式和内容" });
}
