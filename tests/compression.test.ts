import assert from "node:assert/strict";
import test from "node:test";
import {
  Compression,
  datasetText,
  tokens,
} from "../src/server/compression/engine";
import { prepareChat } from "../src/server/compression/service";
import {
  compressionSchemas,
  type Message,
} from "../src/server/compression/schema";
import { chatPayload } from "../src/server/capabilities/models";
import { modelInputSchema } from "../src/lib/model-config";

function engine(
  ask: (m: Message[]) => Promise<string> = async () => "关键决定",
  maxContext = 600,
) {
  return new Compression({
    maxContext,
    maxResponse: 60,
    measure: (m) => tokens(JSON.stringify(m)),
    ask,
  });
}
const question: Message = { role: "user", content: "当前问题" };
test("history boundary is inclusive, keeps current input, and charges complete system messages", async () => {
  const h: Message[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "old" },
    question,
  ];
  for (const [size, calls] of [
    [79, 0],
    [80, 1],
    [81, 1],
  ]) {
    const c = new Compression({
      maxContext: 100,
      maxResponse: 8,
      measure: (m) => (m === h ? size : 10),
      ask: async () => "digest",
    });
    const r = await c.history(h);
    assert.equal(c.calls, calls);
    assert.deepEqual(r.messages.at(-1), question);
    assert.deepEqual(r.messages[0], h[0]);
  }
});
test("overlong history is split into valid subrequests; final payload fits budget", async () => {
  let n = 0;
  const c = engine(async (m) => {
    assert.ok(tokens(JSON.stringify(m)) <= 528);
    n++;
    return "blue";
  });
  const r = await c.history(
    [{ role: "user", content: "long line ".repeat(2000) }, question],
    120,
  );
  assert.ok(n > 2);
  assert.equal(n, r.modelCalls);
  assert.ok(r.tokensAfter <= 120);
  assert.deepEqual(r.messages.at(-1), question);
});
test("failed checkpoint only falls back when full input fits", async () => {
  const c = engine(async () => {
    throw Error("unavailable");
  });
  const h: Message[] = [
    { role: "user", content: "data ".repeat(100) },
    question,
  ];
  assert.deepEqual((await c.history(h, 300, true)).messages, h);
  await assert.rejects(c.history(h, 55), { status: 422 });
});
test("protected messages exceeding the budget fail before model calls", async () => {
  const c = engine();
  await assert.rejects(c.history([question], 1), { status: 422 });
  assert.equal(c.calls, 0);
});
test("tool budgets use remaining space per call; zero budget cannot send oversize data", async () => {
  const c = engine();
  assert.equal(c.contentBudget(428, 4), 25);
  assert.equal(c.contentBudget(), 300);
  await assert.rejects(c.text("some data", 0), { status: 422 });
  assert.equal(c.calls, 0);
});
test("file and tool cleaner and final token cap cover unicode and excessive model output", async () => {
  const c = engine(async () => "🙂中文示例".repeat(40));
  const r = await c.text("活动记录".repeat(150), 18);
  assert.ok(r.tokensAfter <= 18);
  assert.ok(r.warnings.length);
  assert.equal(r.modelCalls, 1);
  const original = await c.text("  保留原文  ", 20);
  assert.equal(original.text, "  保留原文  ");
  assert.equal(original.modelCalls, 0);
});
test("selection validates IDs, deduplicates, preserves metadata and handles invalid answers", async () => {
  const chunks = [
    { id: "a", text: "x ".repeat(80), score: 1 },
    { id: "b", text: "short", source: "report", score: 2 },
  ];
  const c = engine(async () => '["wrong","b","b"]');
  const r = await c.dataset("q", chunks, 50);
  assert.deepEqual(r.chunks, [chunks[1]]);
  const fallback = await engine(async () => "wrong").dataset("q", chunks, 50);
  assert.deepEqual(fallback.selectedIds, ["b"]);
  assert.ok(fallback.warnings.length);
  const empty = await c.dataset("q", [], 10);
  assert.equal(empty.modelCalls, 0);
  assert.equal(empty.tokensAfter, 0);
  assert.ok(
    !compressionSchemas.compressDatasetResults.safeParse({
      query: "q",
      chunks: [chunks[0], chunks[0]],
    }).success,
  );
});
test("dataset threshold is strict, whole single chunk can fit exactly", async () => {
  const chunks = [{ id: "x", text: "example ".repeat(80) }];
  const size = tokens(datasetText(chunks));
  const c = engine(async () => '["x"]', size * 5);
  assert.equal((await c.dataset("q", chunks)).modelCalls, 0);
  const single = engine(async () => '["x"]', size * 5 - 1);
  const r = await new Compression(
    { ...single.runtime, maxResponse: 1 },
    1,
  ).dataset("q", chunks, size);
  assert.deepEqual(r.chunks, chunks);
  assert.equal(r.modelCalls, 1);
});
test("all raw evidence is reviewed before the first model call, including fallback or failed review", async () => {
  const c = engine();
  const chat = {
    messages: [question],
    compression: {
      enabled: true,
      sources: [
        { type: "tool" as const, toolName: "report", result: "A ".repeat(300) },
        {
          type: "dataset" as const,
          query: "query",
          chunks: [{ id: "b", source: "review-me", text: "B".repeat(70) }],
        },
      ],
    },
  };
  let reviewed = 0;
  await assert.rejects(
    prepareChat(chat, c, async (text) => {
      reviewed++;
      assert.ok(text.includes("review-me"));
      throw Error("denied");
    }),
    /denied/,
  );
  assert.equal(reviewed, 1);
  assert.equal(c.calls, 0);
});
test("auto keeps question and instructions with multiple sources under the final limit", async () => {
  const c = engine();
  const r = await prepareChat(
    {
      messages: [{ role: "system", content: "keep" }, question],
      compression: {
        enabled: true,
        sources: [
          { type: "tool", toolName: "a", result: "input ".repeat(500) },
          { type: "tool", toolName: "b", result: "small" },
        ],
      },
    },
    c,
  );
  assert.deepEqual(r.messages[0], { role: "system", content: "keep" });
  assert.deepEqual(r.messages.at(-1), question);
  assert.ok(r.compression.tokensAfter <= c.budget);
  assert.equal(r.compression.sources[1].modelCalls, 0);
  assert.equal(c.calls, 2);
});
test("budget serializer includes protocol-specific instructions and configured model options", () => {
  for (const protocol of ["anthropic", "openai"] as const) {
    const model = modelInputSchema.parse({
      providerId: "custom",
      baseUrl: "https://example.com",
      upstreamModel: "x",
      protocol,
      defaultConfig: { top_p: 0.7 },
    });
    const p = chatPayload(model, {
      messages: [{ role: "system", content: "rules" }, question],
      maxTokens: 10,
      compression: { enabled: true },
    });
    assert.equal(p.max_tokens, 10);
    assert.equal(p.top_p, 0.7);
    assert.ok(!("compression" in p));
    if (protocol === "anthropic") {
      assert.equal(p.system, "rules");
      assert.deepEqual(p.messages, [question]);
    } else assert.equal((p.messages as Message[]).length, 2);
  }
});
