import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { modelInputSchema, type ModelType } from "../src/lib/model-config";
import { callModel } from "../src/server/capabilities/models";
import { getFile, saveFile } from "../src/server/capabilities/files";
import { moderate, enhancedPdf } from "../src/server/capabilities/providers";
import { ModelError } from "../src/server/capabilities/base";
import { send } from "../src/server/capabilities/network";
const base = { _id: "test", name: "test", enabled: true, key: "fixture" };
const pdf = Buffer.from("%PDF-1.4");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const config =
  (protocol: "openai" | "anthropic" = "openai") =>
  async (type: ModelType) => ({
    revision: 1,
    apiKey: "fixture",
    input: modelInputSchema.parse({
      providerId: "openai",
      upstreamModel: "fixture",
      baseUrl: "https://example.com/v1",
      protocol,
      type,
    }),
  });
test("custom PDF sends original file and bearer key and decodes pages", async () => {
  const res = await enhancedPdf(
    { ...base, kind: "customPdf", url: "https://pdf.example/parse" },
    pdf,
    async (u, m, h, b) => {
      assert.equal(m, "POST");
      assert.equal(u.pathname, "/parse");
      assert.equal(h.Authorization, "Bearer fixture");
      assert.match(h["Content-Type"], /multipart/);
      assert.ok(b?.includes(pdf));
      return encoded({ markdown: "hello", pages: 3 });
    },
  );
  assert.deepEqual(res, { rawText: "hello", pages: 3 });
});
test("TextIn sends a raw PDF, paired credentials and image parameters", async () => {
  const res = await enhancedPdf(
    { ...base, kind: "textin", appId: "app" },
    pdf,
    async (u, m, h, b) => {
      assert.equal(h["x-ti-app-id"], "app");
      assert.equal(h["x-ti-secret-code"], "fixture");
      assert.equal(u.searchParams.get("image_output_type"), "base64str");
      assert.equal(b, pdf);
      return encoded({
        code: 200,
        result: { markdown: "text", total_page_number: 2 },
      });
    },
  );
  assert.deepEqual(res, { rawText: "text", pages: 2 });
});
test("Doc2X uploads to signed address without credentials and polls to success", async () => {
  let n = 0;
  const res = await enhancedPdf(
    { ...base, kind: "doc2x" },
    pdf,
    async (u, m, h, b) => {
      n++;
      if (n === 1) {
        assert.equal(u.pathname, "/api/v2/parse/preupload");
        assert.equal(h.Authorization, "Bearer fixture");
        return encoded({
          code: "ok",
          data: { uid: "test", url: "https://storage.example/signed?q=token" },
        });
      }
      if (n === 2) {
        assert.equal(m, "PUT");
        assert.ok(!h.Authorization);
        assert.equal(b, pdf);
        return Buffer.alloc(0);
      }
      assert.equal(u.searchParams.get("uid"), "test");
      return encoded({
        code: "success",
        data:
          n === 3
            ? { status: "processing" }
            : {
                status: "success",
                result: { pages: [{ md: "a" }, { md: "b" }] },
              },
      });
    },
    async () => {},
  );
  assert.equal(n, 4);
  assert.deepEqual(res, { rawText: "a\nb", pages: 2 });
});
test("provider errors and invalid PDF are reported", async () => {
  await assert.rejects(
    enhancedPdf({ ...base, kind: "textin" }, pdf, async () =>
      encoded({ code: 402 }),
    ),
    { status: 502 },
  );
  await assert.rejects(
    enhancedPdf({ ...base, kind: "textin" }, Buffer.from("txt")),
    { status: 422 },
  );
  await assert.rejects(send(new URL("http://127.0.0.1:3011"), "GET", {}), {
    status: 400,
  });
});
test("HTTP moderation distinguishes allow, reject, bad responses and outage", async () => {
  const c = {
    ...base,
    kind: "moderation" as const,
    url: "https://moderation.example",
  };
  for (const [code, d] of [
    [0, "allow"],
    [200, "allow"],
    [5000, "reject"],
  ] as const) {
    const result = await moderate(c, "text", async (_u, _m, _h, b) => {
      assert.deepEqual(JSON.parse(b!.toString()), { text: "text" });
      return encoded({ code });
    });
    assert.equal(result.decision, d);
  }
  await assert.rejects(
    moderate(c, "text", async () => encoded({ code: 501 })),
    { status: 502 },
  );
  await assert.rejects(
    moderate(c, "text", async () => {
      throw new ModelError(504, "timeout");
    }),
    { status: 504 },
  );
});
test("OpenAI and Anthropic chat use their respective message contracts", async () => {
  for (const protocol of ["openai", "anthropic"] as const) {
    const result = await callModel(
      "modelChat",
      {
        messages: [
          { role: "system", content: "rule" },
          { role: "user", content: "hi" },
        ],
      },
      config(protocol),
      async (u, _m, h, b) => {
        const body = JSON.parse(b!.toString());
        if (protocol === "anthropic") {
          assert.equal(body.system, "rule");
          assert.equal(body.messages.length, 1);
          assert.equal(u.pathname, "/v1/messages");
          assert.equal(h["x-api-key"], "fixture");
          return encoded({ content: [{ type: "text", text: "ok" }] });
        }
        assert.equal(u.pathname, "/v1/chat/completions");
        assert.equal(body.messages.length, 2);
        return encoded({ choices: [{ message: { content: "ok" } }] });
      },
    );
    assert.ok(result);
  }
});
test("embedding and rerank validate real result structures", async () => {
  const embeddings = { data: [{ embedding: [0.5, -0.5] }] };
  assert.deepEqual(
    await callModel(
      "modelEmbed",
      { input: ["test"] },
      config(),
      async (u, _m, _h, b) => {
        assert.equal(u.pathname, "/v1/embeddings");
        assert.deepEqual(JSON.parse(b!.toString()).input, ["test"]);
        return encoded(embeddings);
      },
    ),
    embeddings,
  );
  const ranking = { results: [{ index: 0, relevance_score: 0.7 }] };
  assert.deepEqual(
    await callModel(
      "modelRerank",
      { query: "q", documents: ["a"], topN: 1 },
      config(),
      async (u, _m, _h, b) => {
        assert.equal(u.pathname, "/v1/rerank");
        assert.equal(JSON.parse(b!.toString()).top_n, 1);
        return encoded(ranking);
      },
    ),
    ranking,
  );
  await assert.rejects(
    callModel("modelEmbed", { input: "test" }, config(), async () =>
      encoded({ data: [{}] }),
    ),
    { status: 502 },
  );
});
test("speech synthesis stores audio and transcription uploads the original bytes", async () => {
  const prev = process.env.WORKFLOW_FILE_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-speech-"));
  process.env.WORKFLOW_FILE_DIR = dir;
  const audio = Buffer.from("ID3 audio fixture");
  try {
    const result = (await callModel(
      "modelTts",
      { input: "sample", voice: "test" },
      config(),
      async (u, _m, _h, b) => {
        assert.equal(u.pathname, "/v1/audio/speech");
        assert.equal(JSON.parse(b!.toString()).voice, "test");
        return audio;
      },
    )) as { file: { id: string } };
    assert.deepEqual(await (await getFile(result.file.id)).bytes(), audio);
    const input = await saveFile(audio, "input.mp3", "audio/mpeg");
    assert.deepEqual(
      await callModel(
        "modelStt",
        { fileId: input.id, language: "zh" },
        config(),
        async (u, _m, h, b) => {
          assert.equal(u.pathname, "/v1/audio/transcriptions");
          assert.match(h["Content-Type"], /multipart/);
          assert.ok(b?.includes(audio));
          assert.ok(b?.includes("input.mp3"));
          return encoded({ text: "样本" });
        },
      ),
      { text: "样本" },
    );
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_FILE_DIR;
    else process.env.WORKFLOW_FILE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Doc2X stores one image when several Markdown links share an upstream image", async () => {
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  const res = await enhancedPdf(
    { ...base, kind: "doc2x" },
    pdf,
    async (u, method, headers) => {
      if (u.pathname.endsWith("/preupload"))
        return encoded({
          code: "ok",
          data: { uid: "x", url: "https://file.example/upload" },
        });
      if (method === "PUT") return Buffer.alloc(0);
      if (u.pathname.endsWith("/status"))
        return encoded({
          code: "ok",
          data: {
            status: "success",
            result: {
              pages: [
                {
                  md: "![x](https://img.example/img) ![y](https://img.example/img)",
                },
              ],
            },
          },
        });
      assert.equal(headers.Authorization, undefined);
      return bytes;
    },
  );
  assert.ok("imageList" in res && res.imageList);
  assert.equal(res.imageList.length, 1);
  assert.equal(res.imageList[0].mime, "image/png");
  assert.equal(res.rawText.split(res.imageList[0].uuid).length, 3);
});
