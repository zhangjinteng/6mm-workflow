import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostCommandSchema, shellPolicySchema, requiresShellApproval, redactShellText } from "../src/lib/host-shell";
import { hostEnvironment, runHostProcess } from "../src/server/host-shell/process";
import { canonicalCwd, hostDisabled } from "../src/server/host-shell/service";
import { PUT as policyRoute } from "../src/app/api/shell/policy/route";
import { POST as executeRoute } from "../src/app/api/shell/executions/route";
import { POST as decisionRoute } from "../src/app/api/shell/executions/[id]/route";

test("only exact fixed diagnostics bypass managed approval", () => {
  for (const command of ["pwd", "whoami", "uname -a", "/bin/pwd"]) assert.equal(requiresShellApproval(command), false);
  for (const command of ["ls", "rm -rf x", "git push", "npm install", "curl localhost", "pwd; touch x", "pwd\nrm x", "pwd > x", "$(pwd)", "env pwd", "cd /; pwd", "pwd | sh", "printf safe", "sudo id", "uname `whoami`", "./pwd"]) assert.equal(requiresShellApproval(command), true, command);
});
test("model tool arguments cannot change mode or approve commands", () => {
  assert.equal(hostCommandSchema.safeParse({ command: "pwd", mode: "danger-full-access" }).success, false);
  assert.equal(hostCommandSchema.safeParse({ command: "pwd", approved: true }).success, false);
  assert.equal(hostCommandSchema.safeParse({ command: "pwd\0x" }).success, false);
  assert.equal(hostCommandSchema.safeParse({ command: "pwd", timeout: 121 }).success, false);
});
test("host policy requires explicit risk acknowledgement", () => {
  for (const mode of ["host-shell", "danger-full-access"]) {
    assert.equal(shellPolicySchema.safeParse({ mode, cwd: "/tmp", revision: 0 }).success, false);
    assert.equal(shellPolicySchema.safeParse({ mode, cwd: "/tmp", revision: 0, acknowledged: true }).success, true);
  }
  assert.equal(shellPolicySchema.safeParse({ mode: "isolated-shell", cwd: "/tmp", revision: 0 }).success, true);
});
test("host environment never inherits server secrets or startup hooks", () => {
  const old = process.env.WORKFLOW_TEST_SECRET;
  process.env.WORKFLOW_TEST_SECRET = "should-not-pass";
  try {
    const env = hostEnvironment();
    for (const key of ["WORKFLOW_TEST_SECRET", "MONGODB_PASSWORD", "MODEL_CREDENTIAL_KEY", "HOME", "ENV", "BASH_ENV", "NODE_OPTIONS"]) assert.equal(env[key], undefined);
    assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  } finally { if (old === undefined) delete process.env.WORKFLOW_TEST_SECRET; else process.env.WORKFLOW_TEST_SECRET = old; }
});
test("audit redaction covers known keys, assignments, bearer tokens and URL passwords", () => {
  const text = redactShellText('printf unique-key; api_key="some-key" password=abc token=xyz Bearer other-secret https://user:pass@example.com', ["unique-key"]);
  for (const key of ["unique-key", "some-key", "abc", "xyz", "other-secret", "user:pass"]) assert(!text.includes(key));
  assert(text.includes("[REDACTED]"));
});
test("canonical host cwd rejects relative paths and files", async () => {
  await assert.rejects(canonicalCwd("."), /绝对路径/);
  await assert.rejects(canonicalCwd(path.join(process.cwd(), "package.json")), /不存在|不可访问/);
  assert.equal(await canonicalCwd(process.cwd()), process.cwd());
});
test("server kill switches block host access", () => {
  const a = process.env.WORKFLOW_HOST_SHELL_DISABLED, b = process.env.WORKFLOW_SANDBOX_MODE;
  try {
    process.env.WORKFLOW_HOST_SHELL_DISABLED = "1"; assert(hostDisabled());
    delete process.env.WORKFLOW_HOST_SHELL_DISABLED; process.env.WORKFLOW_SANDBOX_MODE = "workspace-write"; assert(hostDisabled());
  } finally {
    if (a === undefined) delete process.env.WORKFLOW_HOST_SHELL_DISABLED; else process.env.WORKFLOW_HOST_SHELL_DISABLED = a;
    if (b === undefined) delete process.env.WORKFLOW_SANDBOX_MODE; else process.env.WORKFLOW_SANDBOX_MODE = b;
  }
});
test("real host process executes in canonical cwd with a minimal environment", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "workflow-host-unit-"));
  try {
    const result = await runHostProcess({ command: 'printf "host-ok\\n"; /bin/pwd; printf "%s" "${MONGODB_PASSWORD-unset}"', cwd, timeout: 3 });
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /host-ok/); assert(result.stdout.includes(path.basename(cwd))); assert(result.stdout.endsWith("unset"));
    await assert.rejects(runHostProcess({ command: "pwd", cwd, timeout: 3 }, async () => false), /取消|权限/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("host timeout kills the command group and bounds output", async () => {
  const result = await runHostProcess({ command: "/bin/sleep 10 & wait", cwd: process.cwd(), timeout: 1 });
  assert.equal(result.exitCode, 124); assert.equal(result.stopped, "timeout"); assert(result.durationMs < 4000);
  const large = await runHostProcess({ command: "/usr/bin/head -c 300000 /dev/zero", cwd: process.cwd(), timeout: 3 });
  assert.equal(large.stdout.length, 256 * 1024); assert.equal(large.truncated, true);
});
test("host cancellation also terminates active descendants", async () => {
  let checks = 0;
  const result = await runHostProcess({ command: "/bin/sleep 10 & wait", cwd: process.cwd(), timeout: 5 }, async () => ++checks < 2);
  assert.equal(result.exitCode, 130); assert.equal(result.stopped, "cancelled"); assert(result.durationMs < 3000);
});
test("HTTP control routes reject cross-origin, missing acknowledgement and forged tool controls", async () => {
  const req = (body: unknown, origin = "http://localhost:16080") => new Request("http://localhost:16080/api/shell/policy", { method: "POST", headers: { host: "localhost:16080", origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await policyRoute(req({}, "https://evil.example"))).status, 403);
  assert.equal((await policyRoute(req({ mode: "danger-full-access", cwd: "/tmp", revision: 0 }))).status, 400);
  assert.equal((await executeRoute(req({ command: "pwd", mode: "danger-full-access" }))).status, 400);
  assert.equal((await executeRoute(req({ command: "pwd", approved: true }))).status, 400);
  assert.equal((await executeRoute(req({ command: "pwd", requestId: "invalid" }))).status, 400);
  assert.equal((await decisionRoute(req({ decision: "approve", confirmed: false }), { params: Promise.resolve({ id: "invalid" }) })).status, 400);
});
