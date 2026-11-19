// Each invocation receives a fresh virtual filesystem. Guest paths are never host paths.
import { Bash } from "just-bash";
import { randomUUID } from "node:crypto";

class DeadlineError extends Error {
  constructor() {
    super("执行超时");
  }
}

async function snapshot(fs) {
  const entries = [];
  let bytes = 0;
  async function visit(dir) {
    for (const name of await fs.readdir("/workspace" + dir)) {
      const relative = dir + "/" + name;
      const path = "/workspace" + relative;
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink) throw Error("工作目录含符号链接，修改未保存");
      if (entries.length >= 512) throw Error("工作目录超过 512 项");
      if (stat.isDirectory) {
        entries.push({ path: relative.slice(1), data: null });
        await visit(relative);
      } else {
        bytes += stat.size;
        if (bytes > 8 * 1024 * 1024) throw Error("工作目录超过 8 MiB");
        const data = await fs.readFileBuffer(path);
        entries.push({
          path: relative.slice(1),
          data: Buffer.from(data).toString("base64"),
        });
      }
    }
  }
  if ((await fs.lstat("/workspace")).isSymbolicLink)
    throw Error("工作目录不能是链接");
  await visit("");
  return entries;
}
async function execute(job) {
  const shell = job.kind === "sandboxShell";
  const js = job.kind === "runJavaScript";
  const bash = new Bash({
    cwd: "/workspace",
    python: !shell && !js,
    javascript: js,
    executionLimitProfile: "hardened",
    executionLimits: {
      maxExecutionTimeMs: job.timeout * 1000,
      maxOutputSize: 512 * 1024,
      maxFileSystemBytes: 16 * 1024 * 1024,
      maxArchiveBytes: 8 * 1024 * 1024,
      maxPythonTimeoutMs: job.timeout * 1000,
      maxJsTimeoutMs: job.timeout * 1000,
    },
  });
  await bash.fs.mkdir("/workspace", { recursive: true });
  if (shell) {
    for (const e of job.entries) {
      const path = "/workspace/" + e.path;
      if (e.data === null) await bash.fs.mkdir(path, { recursive: true });
      else await bash.fs.writeFile(path, Buffer.from(e.data, "base64"));
    }
    const deadline = Date.now() + job.timeout * 1000;
    const { stdout, stderr, exitCode } = await bash.exec(job.command);
    if (exitCode === 124 && Date.now() >= deadline - 5)
      throw new DeadlineError();
    return { stdout, stderr, exitCode, entries: await snapshot(bash.fs) };
  }
  const marker = "WORKFLOW_RESULT_" + randomUUID() + "=";
  const variables = JSON.stringify(job.variables);
  const script = js
    ? job.code +
      "\n;console.log(" +
      JSON.stringify(marker) +
      " + JSON.stringify(await main(JSON.parse(" +
      JSON.stringify(variables) +
      "))));"
    : job.code +
      "\nimport json as _workflow_json\nprint(" +
      JSON.stringify(marker) +
      " + _workflow_json.dumps(main(_workflow_json.loads(" +
      JSON.stringify(variables) +
      ")), allow_nan=False))";
  const file = js ? "/workspace/main.mjs" : "/workspace/main.py";
  await bash.fs.writeFile(file, script);
  const result = await bash.exec(
    js ? "js-exec -m /workspace/main.mjs" : "python3 /workspace/main.py",
  );
  if (result.exitCode === 124) throw new DeadlineError();
  if (result.exitCode !== 0)
    throw Error(result.stderr.slice(-2000) || "代码执行失败");
  const at = result.stdout.lastIndexOf(marker);
  if (at < 0) throw Error("main 未返回 JSON 对象");
  const value = JSON.parse(result.stdout.slice(at + marker.length));
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw Error("main 必须返回 JSON 对象");
  return { codeReturn: value, log: result.stdout.slice(0, at) + result.stderr };
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const result = await execute(JSON.parse(Buffer.concat(chunks)));
  process.stdout.write(JSON.stringify({ result }), () => process.exit(0));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error: String(error.message).slice(-2000),
      timedOut: error instanceof DeadlineError,
    }),
    () => process.exit(0),
  );
}
