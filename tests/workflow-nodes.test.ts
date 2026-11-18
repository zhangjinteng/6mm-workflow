import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createNodeRoute } from "../src/server/workflow-nodes/http";
import { executeNode } from "../src/server/workflow-nodes/execute";
import { nodeRequestSchema } from "../src/server/workflow-nodes/schema";
import { nodeTypes, type NodeType } from "../src/server/workflow-nodes/registry";
import { fixtures } from "./node-fixtures";

/** Exercise the same Request/Response boundary used by each independent Next route. */
async function invoke(node: NodeType, payload: unknown) {
  const response = await createNodeRoute(node)(new Request(`http://localhost:16080/api/workflow/nodes/${node}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}

for (const node of nodeTypes) {
  test(`${node}: has its own POST route and executes the migrated function`, async () => {
    const route = path.resolve(`src/app/api/workflow/nodes/${node}/route.ts`);
    const exports = await import(pathToFileURL(route).href);
    assert.equal(exports.runtime, "nodejs");
    assert.equal(typeof exports.POST, "function");
    const response: Response = await exports.POST(new Request(`http://localhost:16080/api/workflow/nodes/${node}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixtures[node]),
    }));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.nodeType, node);
    assert.ok(body.data.result);
  });
}

test("manifest covers exactly 21 nodes and every source snapshot exists", async () => {
  assert.equal(nodeTypes.length, 21);
  const manifest = JSON.parse(await readFile("src/server/workflow-nodes/manifest.json", "utf8"));
  assert.deepEqual(manifest.nodes.map((item: { nodeType: string }) => item.nodeType), nodeTypes);
  for (const item of manifest.files) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const source = await readFile(`src/server/workflow-nodes/vendor/${item.file.replace(/\.tsx?$/, ".js")}`, "utf8");
    assert.ok(source.includes(`Source: fastify/vendor/${item.file}`));
    assert.ok(!source.includes("localhost:3011"));
    assert.ok(!source.includes("@fastgpt/"));
  }
});

test("answer preserves original result fields and collects stream events", async () => {
  const { body } = await invoke("answerNode", fixtures.answerNode);
  assert.equal(body.data.result.answerText, "\nhello");
  assert.equal(body.data.result.data.answerText, "\nhello");
  assert.equal(body.data.events[0].event, "fastAnswer");
});

test("workflowStart merges query files and variable file list", async () => {
  const { body } = await invoke("workflowStart", {
    params: { userChatInput: "fallback" }, variables: { fileUrlList: ["https://files/2"] },
    context: { query: [{ text: { content: "query" } }, { file: { url: "https://files/1" } }] },
  });
  assert.deepEqual(body.data.result.data, { userChatInput: "query", userFiles: ["https://files/1", "https://files/2"] });
});

test("datasetConcat merges duplicate references and counts tokens locally", async () => {
  const record = { id: "a", q: "hi", a: "hello", score: [] };
  const { status, body } = await invoke("datasetConcatNode", { params: { limit: 100, source1: [record], source2: [record] } });
  assert.equal(status, 200);
  assert.equal(body.data.result.data.quoteQA.length, 1);
  assert.equal(body.data.result.responseData.concatLength, 1);
  assert.ok(body.data.result.data.quoteQA[0].score.length > 0);
});

test("variableUpdate executes ordered numeric operations and returns state", async () => {
  const { body } = await invoke("variableUpdate", {
    variables: { count: 2 },
    params: { updateList: [
      { variable: ["VARIABLE_NODE_ID", "count"], renderType: "input", valueType: "number", value: ["", "3"], numberOperator: "+" },
      { variable: ["VARIABLE_NODE_ID", "count"], renderType: "input", valueType: "number", value: ["", "4"], numberOperator: "*" },
    ] },
  });
  assert.equal(body.data.variables.count, 20);
  assert.deepEqual(body.data.result.responseData.updateVarResult, [5, 20]);
  assert.equal(body.data.events[0].event, "updateVariables");
});

test("variableUpdate can update a referenced node output", async () => {
  const { status, body } = await invoke("variableUpdate", {
    params: { updateList: [{ variable: ["other", "answer"], renderType: "input", valueType: "string", value: ["", "new"] }] },
    context: { runtimeNodes: [{ nodeId: "other", flowNodeType: "answerNode", outputs: [{ id: "answer", value: "old" }] }] },
  });
  assert.equal(status, 200);
  assert.equal(body.data.runtimeNodes.find((item: { nodeId: string }) => item.nodeId === "other").outputs[0].value, "new");
});

test("textEditor uses the original template replacement", async () => {
  const { body } = await invoke("textEditor", fixtures.textEditor);
  assert.equal(body.data.result.data.system_text, "Hello ZJT");
});

test("ifElse uses runtime variable references and returns skipped handles", async () => {
  const { body } = await invoke("ifElseNode", {
    variables: { count: 3 }, params: { ifElseList: [{ condition: "AND", list: [{ variable: ["VARIABLE_NODE_ID", "count"], condition: "greaterThan", value: "2" }] }] },
  });
  assert.equal(body.data.result.data.ifElseResult, "IF");
  assert.deepEqual(body.data.result.skipHandleId, ["ifElseNode-source-ELSE"]);
});

test("userSelect pauses and accepts explicitly supplied resume context", async () => {
  const first = await invoke("userSelect", fixtures.userSelect);
  assert.equal(first.body.data.result.INTERACTIVE.type, "userSelect");
  const resumed = await invoke("userSelect", { ...fixtures.userSelect,
    context: { node: { isEntry: true }, lastInteractive: { type: "userSelect" }, query: [{ text: { content: "A" } }], histories: [{}, {}, {}] },
  });
  assert.equal(resumed.body.data.result.data.selectResult, "A");
  assert.equal(resumed.body.data.result.rewriteHistories.length, 1);
});

test("formInput resumes ordinary JSON text without the storage runtime", async () => {
  const { status, body } = await invoke("formInput", { ...fixtures.formInput,
    context: { node: { isEntry: true }, lastInteractive: { type: "userInput" }, query: [{ text: { content: '{"name":"ZJT"}' } }] },
  });
  assert.equal(status, 200);
  assert.deepEqual(body.data.result.data.formInputResult, { name: "ZJT" });
});

test("loopRunStart keeps array and conditional branches", async () => {
  const { body } = await invoke("loopRunStart", { params: { loopRunMode: "conditional", loopStartIndex: 3 } });
  assert.deepEqual(body.data.result.data, { currentIteration: 3 });
});

for (const node of ["parallelRun", "loopRun", "loop"] as const) {
  test(`${node}: reports unavailable child workflow execution without pretending success`, async () => {
    const params = node === "loopRun" ? { loopRunMode: "array", loopRunInputArray: [1] } : { loopInputArray: [1] };
    const { status, body } = await invoke(node, { params });
    assert.equal(status, 501, JSON.stringify(body));
    assert.equal(body.error, "runtimeUnavailable");
    assert.deepEqual(body.capabilities, ["workflowEngine"]);
  });
}

test("loopRun conditional validation still returns original node error", async () => {
  const { status, body } = await invoke("loopRun", { params: { loopRunMode: "conditional" } });
  assert.equal(status, 200);
  assert.equal(body.data.result.error.system_error_text, "workflow:loop_run_conditional_requires_break");
});

test("pluginInput accepts existing URLs but rejects storage signing explicitly", async () => {
  const withUrl = await invoke("pluginInput", { params: { file: [{ type: "file", url: "https://example/file" }] } });
  assert.equal(withUrl.status, 200);
  assert.deepEqual(withUrl.body.data.result.data.file, ["https://example/file"]);
  const missing = await invoke("pluginInput", { params: { file: [{ type: "file", key: "chat/file" }] } });
  assert.equal(missing.status, 501);
  assert.deepEqual(missing.body.capabilities, ["chatFileSigning"]);
});

test("encrypted form field does not silently become plaintext", async () => {
  const { status, body } = await invoke("formInput", {
    params: { userInputForms: [{ key: "password", type: "password" }] },
    context: { node: { isEntry: true }, lastInteractive: { type: "userInput" }, query: [{ text: { content: JSON.stringify({ password: { secret: "encrypted" } }) } }] },
  });
  assert.equal(status, 501);
  assert.deepEqual(body.capabilities, ["secretDecryption"]);
});

test("requests do not mutate caller input or retain state across invocations", async () => {
  const parsed = nodeRequestSchema.parse({ params: { system_textareaInput: "{{name}}" }, variables: { name: "first" } });
  const before = structuredClone(parsed);
  const result = await executeNode("textEditor", parsed);
  assert.deepEqual(parsed, before);
  assert.equal((result.data.result as { data: { system_text: string } }).data.system_text, "first");
  const fresh = await invoke("userGuide", { params: {} });
  assert.deepEqual(fresh.body.data.result, {});
});

test("runtime capability diagnostics stay isolated between concurrent calls", async () => {
  const [missing, ordinary] = await Promise.all([
    invoke("parallelRun", { params: { loopInputArray: [1] } }),
    invoke("textEditor", fixtures.textEditor),
  ]);
  assert.equal(missing.status, 501);
  assert.equal(ordinary.status, 200);
});

test("malformed JSON and invalid node parameters return 400", async () => {
  const malformed = await createNodeRoute("answerNode")(new Request("http://localhost:16080/api/workflow/nodes/answerNode", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await invoke("variableUpdate", { params: { updateList: "bad" } })).status, 400);
  assert.equal((await invoke("ifElseNode", { params: {} })).status, 400);
  assert.equal((await invoke("userGuide", { params: {}, context: { modulePath: "arbitrary" } })).status, 400);
});

test("wrong content type and non-local / cross-origin requests are rejected", async () => {
  const route = createNodeRoute("stopTool");
  const plain = await route(new Request("http://localhost:16080/api/workflow/nodes/stopTool", { method: "POST", body: "{}" }));
  assert.equal(plain.status, 415);
  for (const [url, headers] of [
    ["http://example.com/api/workflow/nodes/stopTool", {}],
    ["http://localhost:16080/api/workflow/nodes/stopTool", { origin: "https://attacker.example" }],
    ["http://localhost:16080/api/workflow/nodes/stopTool", { "x-forwarded-for": "192.0.2.1" }],
  ] as const) {
    assert.equal((await route(new Request(url, { method: "POST", headers }))).status, 403);
  }
});

test("Next bind address does not reject a localhost Host header", async () => {
  const response = await createNodeRoute("stopTool")(new Request("http://0.0.0.0:16080/api/workflow/nodes/stopTool", {
    method: "POST", headers: { host: "localhost:16080", "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(response.status, 200);
});

test("internal function errors have a structured response without server stack traces", async () => {
  const { status, body } = await invoke("ifElseNode", { params: { ifElseList: [{ condition: "AND", list: [{ variable: ["VARIABLE_NODE_ID", "value"], condition: "reg", value: "[" }] }] }, variables: { value: "hello" } });
  assert.equal(status, 422);
  assert.equal(body.error, "nodeExecutionFailed");
  assert.ok(!JSON.stringify(body).includes("/Users/"));
});

test("signal, passthrough, feedback, legacy-loop and config functions keep original results", async () => {
  const stop = await invoke("stopTool", fixtures.stopTool);
  assert.deepEqual(stop.body.data.result, { responseData: { toolStop: true } });
  const params = await invoke("toolParams", fixtures.toolParams);
  assert.deepEqual(params.body.data.result.data, { question: "hello" });
  const output = await invoke("pluginOutput", fixtures.pluginOutput);
  assert.deepEqual(output.body.data.result.responseData.pluginOutput, { answer: "hello" });
  const feedback = await invoke("customFeedback", fixtures.customFeedback);
  assert.deepEqual(feedback.body.data.result.customFeedbacks, ["feedback"]);
  const start = await invoke("loopStart", fixtures.loopStart);
  assert.deepEqual(start.body.data.result.data, { loopStartInput: "item", loopStartIndex: 2 });
  const end = await invoke("loopEnd", fixtures.loopEnd);
  assert.equal(end.body.data.result.responseData.loopOutputValue, "done");
  const signal = await invoke("loopRunBreak", fixtures.loopRunBreak);
  assert.deepEqual(signal.body.data.result, { data: {}, responseData: {} });
  const guide = await invoke("userGuide", fixtures.userGuide);
  assert.deepEqual(guide.body.data.result, { city: "Hangzhou" });
});

test("existing current-node inputs and outputs survive context adaptation", async () => {
  const { status, body } = await invoke("userGuide", { params: {}, context: {
    node: { nodeId: "current" },
    runtimeNodes: [{ nodeId: "current", flowNodeType: "userGuide", inputs: [{ key: "a", value: 1 }], outputs: [{ id: "b", value: 2 }] }],
  } });
  assert.equal(status, 200);
  assert.equal(body.data.runtimeNodes.length, 1);
  assert.deepEqual(body.data.runtimeNodes[0].inputs, [{ key: "a", value: 1 }]);
  assert.deepEqual(body.data.runtimeNodes[0].outputs, [{ id: "b", value: 2 }]);
});
