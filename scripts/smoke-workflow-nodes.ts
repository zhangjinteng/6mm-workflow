import assert from "node:assert/strict";
import { fixtures } from "../tests/node-fixtures";

const baseUrl = process.env.NODE_API_BASE_URL ?? "http://localhost:16080";

/** Verify the real Next server, including route discovery and bundling of every handler. */
async function post(node: string, payload: unknown, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}/api/workflow/nodes/${node}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${node}: ${JSON.stringify(body)}`);
  assert.equal(body.code, expectedStatus);
  if (expectedStatus === 200) assert.equal(body.data.nodeType, node);
  process.stdout.write(`${response.status} ${node}\n`);
  return body;
}

for (const [node, payload] of Object.entries(fixtures)) await post(node, payload);
for (const node of ["parallelRun", "loopRun", "loop"]) {
  const params = node === "loopRun" ? { loopRunMode: "array", loopRunInputArray: [1] } : { loopInputArray: [1] };
  const body = await post(node, { params }, 501);
  assert.equal(body.error, "runtimeUnavailable");
  assert.deepEqual(body.capabilities, ["workflowEngine"]);
}
await post("variableUpdate", { params: { updateList: "bad" } }, 400);
process.stdout.write("21 independent routes and 4 failure-path checks passed.\n");
