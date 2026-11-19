import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { modelInputSchema } from "../src/lib/model-config";
import { saveFile, getFile } from "../src/server/capabilities/files";
import { agentSchemas, assemble } from "../src/server/agent/catalog";
import {
  executeTool,
  imageBlocks,
  prepareResources,
} from "../src/server/agent/resources";
import {
  completion,
  parseReply,
  plain,
  wire,
  type Connection,
} from "../src/server/agent/model";
import { result, unfinished } from "../src/server/agent/engines";
import type { ToolCall } from "@mariozechner/pi-ai";
const model = modelInputSchema.parse({
  name: "Test",
  providerId: "custom",
  upstreamModel: "fixture",
  baseUrl: "https://example.com/v1",
  capabilities: ["vision"],
  maxContext: 16000,
});
const connection: Connection = {
  id: randomUUID(),
  input: model,
  apiKey: "test-only",
  revision: 1,
};
const options = (v: unknown) => agentSchemas.previewAgentTools.parse(v);
const fileCall: ToolCall = {
  type: "toolCall",
  id: "call-1",
  name: "read_files",
  arguments: { fileIds: [randomUUID()] },
};
test("preview selects only registered tools and explains restrictions", async () => {
  const c = await assemble(
    options({
      selectedTools: ["textToChunks", "dataset_search", "sandbox_shell"],
      sandbox: "workspace-write",
      canSelectFile: false,
    }),
    model,
  );
  assert.ok(c.tools.some((t) => t.name === "textToChunks"));
  assert.ok(
    !c.tools.some((t) => t.name === "read_files" || t.name === "sandbox_shell"),
  );
  assert.deepEqual(
    c.excluded.map((x) => x.name),
    ["dataset_search", "sandbox_shell"],
  );
  assert.match(
    c.unavailable.find((t) => t.name === "sandbox_shell")!.reason,
    /workspace-write/,
  );
  await assert.rejects(
    executeTool("read_files", fileCall.arguments, c, undefined),
    /未装配/,
  );
});
test("history attachment scope is checked before any parsing", async () => {
  const c = await assemble(options({}), model);
  await assert.rejects(
    executeTool("read_files", fileCall.arguments, c, undefined),
    /范围/,
  );
  await assert.rejects(
    executeTool("read_files", { fileIds: [] }, c, undefined),
  );
});
test("Pi refuses an unverified protocol", async () => {
  await assert.rejects(
    assemble(options({ engine: "pi" }), { ...model, protocol: "anthropic" }),
    /Pi/,
  );
});
test("Anthropic multi-call continuation preserves the unfinished siblings", async () => {
  const conn = {
    ...connection,
    input: { ...model, protocol: "anthropic" as const },
  };
  const answer = parseReply(
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "1",
          name: "ask_agent",
          input: { question: "Color?" },
        },
        {
          type: "tool_use",
          id: "2",
          name: "update_plan",
          input: { steps: ["finish"] },
        },
      ],
    },
    conn,
  );
  const pending = unfinished([answer]);
  assert.deepEqual(
    pending.map((c) => c.id),
    ["1", "2"],
  );
  const answered = result(pending[0], "blue");
  assert.deepEqual(
    unfinished([answer, answered]).map((c) => c.id),
    ["2"],
  );
  const final = await completion(
    conn,
    "test",
    [answer, answered, result(pending[1], "ok")],
    [],
    new AbortController().signal,
    async (url, _method, _headers, body) => {
      assert.equal(url.pathname, "/v1/messages");
      const data = JSON.parse(body!.toString());
      assert.deepEqual(
        data.messages[1].content.map(
          (b: { tool_use_id: string }) => b.tool_use_id,
        ),
        ["1", "2"],
      );
      return Buffer.from(
        JSON.stringify({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        }),
      );
    },
  );
  assert.equal(plain(final), "done");
});
test("OpenAI compatible calls preserve tool IDs and reasoning on the second request", () => {
  const a = parseReply(
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            reasoning_content: "fixture",
            tool_calls: [
              {
                id: "c",
                function: {
                  name: "ask_agent",
                  arguments: '{"question":"which?"}',
                },
              },
            ],
          },
        },
      ],
    },
    connection,
  );
  assert.equal(wire(a, false).reasoning_content, "fixture");
  const c = unfinished([a])[0];
  assert.equal(wire(result(c, "green"), false).tool_call_id, "c");
  assert.throws(() =>
    parseReply(
      {
        choices: [{ finish_reason: "length", message: { content: "partial" } }],
      },
      connection,
    ),
  );
});
test("vision transport sends the uploaded image bytes for both wire protocols", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSAAAAABJRU5ErkJggg==",
    "base64",
  );
  const file = await saveFile(bytes, "test.png", "image/png");
  try {
    const p = options({
      attachments: [{ fileId: file.id }],
      modalities: { vision: true },
    });
    const c = await assemble(p, model),
      blocks = await imageBlocks(c);
    for (const protocol of ["anthropic", "openai"] as const) {
      const conn = { ...connection, input: { ...model, protocol } };
      await completion(
        conn,
        "test",
        [
          {
            role: "user",
            content: [{ type: "text", text: "describe the image" }, ...blocks],
            timestamp: 0,
          },
        ],
        c.tools,
        new AbortController().signal,
        async (_u, _m, _h, body) => {
          const b = JSON.parse(body!.toString()).messages.at(-1).content[1];
          assert.deepEqual(
            Buffer.from(
              protocol === "openai"
                ? b.image_url.url.split(",")[1]
                : b.source.data,
              "base64",
            ),
            bytes,
          );
          return Buffer.from(
            JSON.stringify(
              protocol === "openai"
                ? {
                    choices: [
                      {
                        finish_reason: "stop",
                        message: { content: "image received" },
                      },
                    ],
                  }
                : {
                    content: [{ type: "text", text: "image received" }],
                    stop_reason: "end_turn",
                  },
            ),
          );
        },
      );
    }
    assert.equal(
      (await assemble(p, { ...model, capabilities: [] })).media[0].action,
      "excluded",
    );
  } finally {
    await (await getFile(file.id)).remove();
  }
});

test("an explicit STT fallback feeds the transcript to the agent as reference data", async () => {
  const p = options({ modalities: { audio: "transcribe" } });
  const c = await assemble(p, model);
  const id = randomUUID();
  c.media.push({
    id,
    name: "sample.wav",
    kind: "audio",
    mime: "audio/wav",
    size: 28,
    action: "transcribe",
    reason: "",
  });
  c.sttModelId = randomUUID();
  const prepared = await prepareResources(
    c,
    p,
    undefined,
    undefined,
    async (fileId, modelId) => {
      assert.equal(fileId, id);
      assert.equal(modelId, c.sttModelId);
      return { text: "随机录音资料 1973" };
    },
  );
  assert.deepEqual(JSON.parse(prepared.promptContext).transcripts, [
    { fileId: id, text: "随机录音资料 1973" },
  ]);
});
