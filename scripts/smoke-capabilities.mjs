import assert from "node:assert/strict";
import JSZip from "jszip";
import XLSX from "xlsx";
import iconv from "iconv-lite";
import { randomUUID } from "node:crypto";

const base = process.env.NODE_API_BASE_URL || "http://127.0.0.1:16080";
const json = { "content-type": "application/json" };
const cleanup = [];
async function api(path, init = {}, status = 200) {
  const res = await fetch(base + path, {
    ...init,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  assert.equal(res.status, status, path + " " + text.slice(0, 250));
  return text ? JSON.parse(text) : null;
}
async function post(name, params, status = 200) {
  const res = await api(
    "/api/workflow/nodes/" + name,
    {
      method: "POST",
      headers: json,
      body: JSON.stringify({ params, variables: { probe: 1 } }),
    },
    status,
  );
  if (status === 200) {
    assert.equal(res.data.nodeType, name);
    assert.equal(res.data.variables.probe, 1);
  }
  console.log(status, name);
  return res.data?.result;
}
async function upload(name, bytes) {
  const form = new FormData();
  form.set("file", new Blob([bytes]), name);
  const { data } = await api("/api/files", { method: "POST", body: form }, 201);
  cleanup.push(["/api/files/" + data.id, 204]);
  return data.id;
}
function simplePdf() {
  const stream = "BT /F1 14 Tf 48 400 Td (sample) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const offset = text.length;
    text += i + 1 + " 0 obj\n" + o + "\nendobj\n";
    return offset;
  });
  const xref = text.length;
  return (
    text +
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n"
  );
}
async function office() {
  const doc = new JSZip();
  doc.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  doc.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>sample</w:t></w:r></w:p></w:body></w:document>',
  );
  const ppt = new JSZip();
  ppt.file("ppt/presentation.xml", "<presentation/>");
  ppt.file(
    "ppt/slides/slide1.xml",
    '<slide xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>sample</a:t></a:r></a:p></slide>',
  );
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["a", "b"],
      [1, "sample"],
    ]),
    "Sheet1",
  );
  return {
    docx: await doc.generateAsync({ type: "nodebuffer" }),
    pptx: await ppt.generateAsync({ type: "nodebuffer" }),
    xlsx: XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
  };
}
try {
  const catalog = (await api("/api/capabilities")).data;
  assert.equal(catalog.length, 31);
  assert.equal(
    (await api("/api/capabilities/modelChat")).data.name,
    "modelChat",
  );
  await api("/api/capabilities/unknown", {}, 404);
  for (const entry of catalog) assert.equal(entry.params.type, "object");
  const files = {
    txt: "sample 文本",
    md: "# sample\n![img](data:image/png;base64,YQ==)",
    csv: 'name,value\nsample,"a,b"',
    html: "<h2>sample</h2>",
    pdf: simplePdf(),
    ...(await office()),
  };
  const ids = {};
  for (const [ext, bytes] of Object.entries(files)) {
    ids[ext] = await upload("probe." + ext, bytes);
    const node =
      ext === "md"
        ? "parseMarkdown"
        : "parse" + ext[0].toUpperCase() + ext.slice(1);
    const out = await post(node, { fileId: ids[ext] });
    assert.match(out.text, /sample/);
    for (const img of out.images) cleanup.push(["/api/files/" + img.id, 204]);
    if (ext === "md") {
      assert.equal(out.images.length, 1);
      assert.ok(out.text.includes(out.images[0].url));
    }
  }
  assert.match((await post("parseFile", { fileId: ids.pdf })).text, /sample/);
  assert.deepEqual(
    (await post("readFiles", { fileIds: [ids.txt, ids.csv] })).files.map(
      (f) => f.fileId,
    ),
    [ids.txt, ids.csv],
  );
  assert.match(
    (await post("htmlToMarkdown", { html: "<h1>test</h1>" })).text,
    /# test/,
  );
  assert.ok(
    (
      await post("textToChunks", {
        text: "sample ".repeat(70),
        chunkSize: 32,
        maxSize: 64,
      })
    ).chunks.length > 1,
  );
  assert.equal(
    (await post("previewFileChunks", { fileId: ids.txt, limit: 1 })).chunks
      .length,
    1,
  );
  const encoded = await upload("encoding.txt", iconv.encode("测试", "gbk"));
  assert.equal(
    (await post("parseTxt", { fileId: encoded, encoding: "gbk" })).text,
    "测试",
  );
  assert.equal((await api("/api/files/" + ids.txt)).data.name, "probe.txt");
  assert.equal(
    await (await fetch(base + "/api/files/" + ids.txt + "/download")).text(),
    files.txt,
  );
  await post("parsePdf", { fileId: ids.txt }, 422);
  await post("parsePdf", { fileId: await upload("bad.pdf", "invalid") }, 422);
  await post("parseFile", { fileId: randomUUID() }, 404);
  await post("textToChunks", { text: "test", chunkSize: 0 }, 400);
  for (const n of ["parsePdfCustom", "parsePdfTextIn", "parsePdfDoc2x"])
    await post(n, { fileId: ids.pdf, integrationId: randomUUID() }, 404);
  const policy = (
    await api(
      "/api/integrations",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          name: "smoke-" + randomUUID(),
          kind: "moderation",
          enabled: false,
          blockedTerms: ["blocked"],
        }),
      },
      201,
    )
  ).data;
  cleanup.push(["/api/integrations/" + policy.id, 200]);
  assert.equal(
    (await api("/api/integrations/" + policy.id)).data.enabled,
    false,
  );
  await post("moderateText", { text: "test", policyId: policy.id }, 503);
  await api("/api/integrations/" + policy.id, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({ enabled: true }),
  });
  for (const [text, decision] of [
    ["sample", "allow"],
    ["BLOCKED", "reject"],
  ])
    assert.equal(
      (await post("moderateText", { text, policyId: policy.id })).decision,
      decision,
    );
  await post(
    "modelChat",
    {
      modelId: randomUUID(),
      messages: [{ role: "user", content: "blocked" }],
      policyId: policy.id,
    },
    422,
  );
  assert.ok(
    (await post("listAuditLogs", { action: "moderateText", limit: 10 })).some(
      (r) => r.outcome === "reject",
    ),
  );
  const id = randomUUID();
  for (const [name, params] of Object.entries({
    modelChat: { messages: [{ role: "user", content: "ok" }] },
    modelEmbed: { input: "x" },
    modelRerank: { query: "x", documents: ["y"] },
    modelTts: { input: "x" },
    modelStt: { fileId: ids.txt },
  }))
    await post(name, { ...params, modelId: id }, 404);
  console.log(
    "23 routes covered; file content, management, policy, audit and errors checked.",
  );
} finally {
  for (const [path, status] of cleanup.reverse())
    await api(path, { method: "DELETE" }, status);
}
