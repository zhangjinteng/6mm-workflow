import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  decodePackages,
  encodePackage,
  metadata,
  safePath,
} from "../src/server/skills/package";
const markdown = "---\nname: test-skill\ndescription: 测试\n---\n\n规则";
test("Skill ZIP round trip preserves markdown and binary resources", async () => {
  const pack = {
    markdown,
    files: new Map([["assets/example.bin", Buffer.from([0, 1, 255])]]),
  };
  assert.deepEqual(await decodePackages(await encodePackage(pack)), [pack]);
});
test("imports root-level legacy packages and separates sibling skills", async () => {
  const zip = new JSZip();
  zip.file("SKILL.md", markdown);
  assert.equal(
    (await decodePackages(await zip.generateAsync({ type: "nodebuffer" })))[0]
      .markdown,
    markdown,
  );
  zip.remove("SKILL.md");
  for (const name of ["a", "b"]) {
    zip.file(name + "/SKILL.md", markdown);
    zip.file(name + "/asset", name);
  }
  const packs = await decodePackages(
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  assert.deepEqual(
    packs.map((p) => p.files.get("asset")?.toString()),
    ["a", "b"],
  );
});
test("invalid packages, traversal and invalid YAML fail explicitly", async () => {
  assert.throws(() => safePath("../private.txt"));
  assert.throws(() => metadata("missing header"));
  const zip = new JSZip();
  zip.file("../a/SKILL.md", markdown);
  await assert.rejects(
    decodePackages(await zip.generateAsync({ type: "nodebuffer" })),
  );
  await assert.rejects(decodePackages(Buffer.from("no zip")));
});
