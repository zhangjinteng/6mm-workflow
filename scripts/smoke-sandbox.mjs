// Run against a running 16080 instance. All mutable fixtures belong to this run.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MongoClient } from "mongodb";

const base = "http://127.0.0.1:16080";
const sessions = new Set();
const uploads = [];
const tokens = [];
async function api(path, method = "GET", body, status = 200, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, status, path + " " + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}
async function node(name, params, status = 200) {
  const body = await api(
    "/api/workflow/nodes/" + name,
    "POST",
    { params, variables: { keep: true } },
    status,
  );
  if (status !== 200) return body;
  assert.equal(body.data.nodeType, name);
  assert.ok(body.data.requestId);
  assert.deepEqual(body.data.variables, { keep: true });
  return body.data.result;
}
async function create(body = {}) {
  const { data } = await api("/api/sandbox/sessions", "POST", body, 201);
  sessions.add(data.sessionId);
  return data;
}
const e = process.env;
let dbClient;
async function db() {
  dbClient ??= new MongoClient(
    "mongodb://" + e.MONGODB_HOST + ":" + (e.MONGODB_PORT || 27017),
    {
      auth: { username: e.MONGODB_USER, password: e.MONGODB_PASSWORD },
      authSource: e.MONGODB_AUTH_SOURCE || e.MONGODB_DATABASE || "workflow",
      tls: e.MONGODB_TLS === "true",
    },
  );
  return dbClient.db(e.MONGODB_DATABASE || "workflow");
}
after(async () => {
  try {
    for (const id of sessions)
      await api("/api/sandbox/sessions/" + id, "DELETE", undefined, 204);
    for (const id of uploads)
      await api("/api/files/" + id, "DELETE", undefined, 204);
    if (tokens.length && e.MONGODB_USER)
      await (await db())
        .collection("workflow16080_sandbox_artifacts")
        .deleteMany({ "files.token": { $in: tokens } });
  } finally {
    await dbClient?.close();
  }
});

test("59 nodes visible, eight new routes discoverable", async () => {
  const page = await (await fetch(base + "/nodes")).text();
  const catalog = (await api("/api/capabilities")).data;
  assert.equal(catalog.length, 38);
  for (const name of [
    "sandboxShell",
    "sandboxReadFile",
    "sandboxWriteFile",
    "sandboxEditFile",
    "sandboxSearch",
    "sandboxGetFileUrl",
    "runJavaScript",
    "runPython",
  ]) {
    assert.ok(page.includes(name));
    const { data } = await api("/api/capabilities/" + name);
    assert.equal(data.method, "POST");
    assert.equal(data.route, "/api/workflow/nodes/" + name);
  }
  assert.equal((page.match(/class="method"/g) || []).length, 59);
});

test("upload, import, read lines, atomic edits, glob search and immutable download", async () => {
  const upload = await fetch(base + "/api/files?name=fixture.txt", {
    method: "POST",
    body: "first\nsecond",
  });
  assert.equal(upload.status, 201);
  const { id } = (await upload.json()).data;
  uploads.push(id);
  const s = await create({ fileIds: [id] });
  const sessionId = s.sessionId;
  assert.equal(
    (await api("/api/sandbox/sessions/" + sessionId)).data.mode,
    "isolated-shell",
  );
  const path = s.attachments[0].path;
  const read = (extra = {}) =>
    node("sandboxReadFile", { sessionId, path, ...extra });
  assert.equal((await read({ startLine: 2 })).content, "second");
  const local = { sessionId, path: "out/note.txt" };
  await node("sandboxWriteFile", { ...local, content: "one" });
  await node(
    "sandboxEditFile",
    {
      sessionId,
      entries: [
        { path, oldContent: "first", newContent: "updated" },
        { path: local.path, oldContent: "missing", newContent: "oops" },
      ],
    },
    409,
  );
  assert.equal((await read()).content, "first\nsecond");
  await node("sandboxEditFile", {
    sessionId,
    entries: [{ path, oldContent: "second", newContent: "updated" }],
  });
  assert.equal((await read()).content, "first\nupdated");
  assert.deepEqual(
    (await node("sandboxSearch", { sessionId, path: "out", pattern: "*.txt" }))
      .paths,
    [local.path],
  );
  const { files } = await node("sandboxGetFileUrl", {
    sessionId,
    paths: [local.path],
  });
  const url = files[0].fileUrl;
  tokens.push(url.split("/").at(-1));
  await node("sandboxWriteFile", { ...local, content: "two" });
  assert.equal(await (await fetch(base + url)).text(), "one");
  const other = await create();
  await node(
    "sandboxReadFile",
    { sessionId: other.sessionId, path: local.path },
    404,
  );
  await node("sandboxReadFile", { sessionId, path: "../note.txt" }, 400);
  await node("sandboxReadFile", { sessionId, path: "/etc/passwd" }, 400);
  if (e.MONGODB_USER) {
    // Expire only the artifact created above, before Mongo's background TTL sweep.
    await (await db())
      .collection("workflow16080_sandbox_artifacts")
      .updateOne(
        { "files.token": tokens.at(-1) },
        { $set: { expiresAt: new Date(0) } },
      );
    await api(url, "GET", undefined, 404);
  }
});

test("Shell shares workspace, handles stderr, symlinks, permission and deadline", async () => {
  const { sessionId } = await create();
  await node("sandboxWriteFile", {
    sessionId,
    path: "in.txt",
    content: "word\n",
  });
  const command =
    "cat in.txt | tr a-z A-Z > result.txt; echo warning >&2; cat result.txt";
  const run = await node("sandboxShell", { sessionId, command });
  assert.deepEqual(run, { stdout: "WORD\n", stderr: "warning\n", exitCode: 0 });
  assert.equal(
    (await node("sandboxReadFile", { sessionId, path: "result.txt" })).content,
    "WORD\n",
  );
  assert.equal(
    (await node("sandboxShell", { sessionId, command: "exit 7" })).exitCode,
    7,
  );
  await node("sandboxShell", { sessionId, command: "ln -s /tmp link" }, 422);
  await node("sandboxReadFile", { sessionId, path: "link" }, 404);
  await node(
    "sandboxShell",
    { sessionId, command: "sleep 10", timeout: 1 },
    504,
  );
  const restricted = await create({ mode: "workspace-write" });
  assert.equal(
    (
      await node("sandboxShell", {
        sessionId: restricted.sessionId,
        command: "echo unreachable",
      })
    ).exitCode,
    -1,
  );
  await api(
    "/api/workflow/nodes/sandboxShell",
    "POST",
    { params: { sessionId, command: "echo nope" } },
    403,
    { Origin: "https://example.com" },
  );
});

test("active Shell is cancelled when the session is closed, repeated delete succeeds", async () => {
  const { sessionId } = await create();
  const pending = node(
    "sandboxShell",
    { sessionId, command: "sleep 15", timeout: 20 },
    504,
  );
  await new Promise((r) => setTimeout(r, 650));
  const url = "/api/sandbox/sessions/" + sessionId;
  await api(url, "DELETE", undefined, 204);
  await pending;
  await api(url, "DELETE", undefined, 204);
  await api(url, "GET", undefined, 404);
});
for (const [name, good, bad, slow] of [
  [
    "runJavaScript",
    "async function main(v) { console.log('addition'); return { sum: v.a + v.b }; }",
    "function main(){throw Error('fixture')}",
    "function main(){while(true){}}",
  ],
  [
    "runPython",
    "def main(v):\n print('addition')\n return {'sum': v['a'] + v['b']}",
    "def main(v):\n raise ValueError('fixture')",
    "def main(v):\n while True: pass",
  ],
]) {
  test(
    name + " real execution, logs, invalid syntax, exception and timeout",
    async () => {
      const r = await node(name, { code: good, variables: { a: 19, b: 23 } });
      assert.deepEqual(r.codeReturn, { sum: 42 });
      assert.match(r.log, /addition/);
      await node(name, { code: "def {" }, 422);
      await node(name, { code: bad }, 422);
      await node(name, { code: slow, timeout: 1 }, 504);
    },
  );
}
test(
  "workspace survives a fresh read, expiry is enforced before TTL cleanup",
  { skip: !e.MONGODB_USER },
  async () => {
    const { sessionId } = await create();
    await (await db())
      .collection("workflow16080_sandbox_sessions")
      .updateOne({ _id: sessionId }, { $set: { expiresAt: new Date(0) } });
    await api("/api/sandbox/sessions/" + sessionId, "GET", undefined, 404);
    await node("sandboxWriteFile", { sessionId, path: "x", content: "x" }, 404);
  },
);

test("code runs in a fresh filesystem and cannot see Agent session files", async () => {
  const { sessionId } = await create();
  await node("sandboxWriteFile", {
    sessionId,
    path: "canary.txt",
    content: "session only",
  });
  const r = await node("runPython", {
    code: "def main(v):\n try:\n  open('/workspace/canary.txt')\n  return {'visible':True}\n except FileNotFoundError:\n  return {'visible':False}",
  });
  assert.deepEqual(r.codeReturn, { visible: false });
});
test("concurrent updates cannot overwrite newer files", async () => {
  const { sessionId } = await create();
  const slow = node(
    "sandboxShell",
    { sessionId, command: "sleep 2; echo late > same" },
    409,
  );
  await new Promise((r) => setTimeout(r, 650));
  await node("sandboxWriteFile", {
    sessionId,
    path: "same",
    content: "current",
  });
  await slow;
  assert.equal(
    (await node("sandboxReadFile", { sessionId, path: "same" })).content,
    "current",
  );
});
