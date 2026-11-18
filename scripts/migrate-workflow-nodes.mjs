import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Mechanical declaration extraction: preserve source function bodies, remove only
// TypeScript types and unrelated top-level declarations/imports.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceArg = process.argv.find((arg) => arg.startsWith("--source="));
if (!sourceArg) throw new Error("Pass --source=/absolute/path/to/workflow-zjt");
const source = path.resolve(sourceArg.slice("--source=".length));
const vendor = path.join(source, "fastify/vendor");
const base = "service/core/workflow/dispatch/";
const nodes = [
  ["workflowStart", "init/workflowStart.tsx", "dispatchWorkflowStart"],
  ["datasetConcatNode", "dataset/concat.ts", "dispatchDatasetConcat"],
  ["answerNode", "tools/answer.ts", "dispatchAnswer"],
  ["variableUpdate", "tools/runUpdateVar.ts", "dispatchUpdateVariable"],
  ["textEditor", "tools/textEditor.ts", "dispatchTextEditor"],
  ["customFeedback", "tools/customFeedback.ts", "dispatchCustomFeedback"],
  ["ifElseNode", "tools/runIfElse.ts", "dispatchIfElse"],
  ["userSelect", "interactive/userSelect.ts", "dispatchUserSelect"],
  ["formInput", "interactive/formInput.ts", "dispatchFormInput"],
  ["parallelRun", "parallelRun/runParallelRun.ts", "dispatchParallelRun"],
  ["loopRun", "loopRun/runLoopRun.ts", "dispatchLoopRun"],
  ["loopRunStart", "loopRun/runLoopRunStart.ts", "dispatchLoopRunStart"],
  ["loopRunBreak", "loopRun/runLoopRunBreak.ts", "dispatchLoopRunBreak"],
  ["loopStart", "loop/runLoopStart.ts", "dispatchLoopStart"],
  ["loopEnd", "loop/runLoopEnd.ts", "dispatchLoopEnd"],
  ["stopTool", "ai/toolcall/stopTool.ts", "dispatchStopToolCall"],
  ["toolParams", "ai/toolcall/toolParams.ts", "dispatchToolParams"],
  ["pluginInput", "plugin/runInput.ts", "dispatchPluginInput"],
  ["pluginOutput", "plugin/runOutput.ts", "dispatchPluginOutput"],
  ["loop", "abandoned/runLoop.ts", "dispatchLoop"],
  ["userGuide", "init/systemConfig.tsx", "dispatchSystemConfig"],
];
const documents = process.argv.includes("--documents");
const moduleRoot = path.join(project, documents ? "workers" : "src/server/workflow-nodes");
const outputRoot = path.join(moduleRoot, "vendor");
const boundaries = new Map([
  ["service/core/workflow/dispatch/index.ts", "engine"],
  ["service/env.ts", "environment"],
  ["service/common/logger/index.ts", "logger"],
  ["service/common/s3/sources/chat/index.ts", "files"],
  ["service/common/secret/aes256gcm.ts", "secrets"],
  ["service/common/string/tiktoken/index.ts", "tokens"],
]);
if (documents) {
  boundaries.set("service/worker/env.ts", "runtime");
  boundaries.set("service/common/logger/index.ts", "runtime");
}
const requests = new Map();
const results = new Map();
const packages = new Set();

/** Queue a union of required exports so shared modules are emitted only once. */
function requestModule(file, names) {
  const entry = requests.get(file) ?? new Set();
  const previousSize = entry.size;
  for (const name of names) entry.add(name);
  requests.set(file, entry);
  return entry.size !== previousSize;
}

/** Resolve only source files inside the original vendor tree. */
function resolveModule(from, specifier) {
  const root = path.resolve(path.dirname(path.join(vendor, from)), specifier);
  const result = [root, `${root}.ts`, `${root}.tsx`, path.join(root, "index.ts")]
    .find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));
  if (!result || !result.startsWith(`${vendor}/`)) {
    throw new Error(`Unresolved source import: ${from}: ${specifier}`);
  }
  return path.relative(vendor, result);
}

/** Collect runtime identifier reads; property names are not local bindings. */
function identifiers(node) {
  const names = new Set();
  const visit = (child) => {
    if (ts.isIdentifier(child)) {
      const parent = child.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === child) return;
      if (ts.isPropertyAssignment(parent) && parent.name === child) return;
      names.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/** Extract the lexical closure of requested exports from transpiled source. */
function extract(file, wanted) {
  const original = readFileSync(path.join(vendor, file), "utf8");
  const compiled = ts.transpileModule(original, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const ast = ts.createSourceFile(file + ".js", compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const definitions = new Map();
  const defineBinding = (binding, statement) => {
    if (ts.isIdentifier(binding)) definitions.set(binding.text, statement);
    else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
      for (const element of binding.elements) {
        if (ts.isBindingElement(element)) defineBinding(element.name, statement);
      }
    }
  };
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        defineBinding(declaration.name, statement);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      definitions.set(statement.name.text, statement);
    } else if (ts.isExportAssignment(statement)) {
      definitions.set("default", statement);
    }
  }
  const selected = new Set();
  const needed = new Set(wanted);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of needed) {
      const statement = definitions.get(name);
      if (statement && !selected.has(statement)) {
        selected.add(statement);
        changed = true;
        for (const reference of identifiers(statement)) needed.add(reference);
      }
    }
    // TypeScript enums are a declaration followed by an initializer IIFE.
    for (const statement of ast.statements) {
      if (!ts.isExpressionStatement(statement) || selected.has(statement)) continue;
      if ([...identifiers(statement)].some((name) => needed.has(name) && definitions.has(name))) {
        selected.add(statement);
        changed = true;
        for (const reference of identifiers(statement)) needed.add(reference);
      }
    }
  }
  for (const name of wanted) {
    if (!definitions.has(name)) throw new Error(`Missing source export ${file}: ${name}`);
  }
  const imports = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = [];
    const dependencyNames = [];
    if (clause.name && needed.has(clause.name.text)) {
      bindings.push(clause.name.text);
      dependencyNames.push("default");
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && needed.has(clause.namedBindings.name.text)) {
      bindings.push("* as " + clause.namedBindings.name.text);
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const selectedBindings = clause.namedBindings.elements.filter((item) => needed.has(item.name.text));
      if (selectedBindings.length) {
        bindings.push(`{ ${selectedBindings.map((item) => item.getText(ast)).join(", ")} }`);
        dependencyNames.push(...selectedBindings.map((item) => (item.propertyName ?? item.name).text));
      }
    }
    if (!bindings.length) continue;
    let destination = specifier;
    if (specifier.startsWith(".")) {
      const dependency = resolveModule(file, specifier);
      const boundary = boundaries.get(dependency);
      const target = boundary
        ? path.join(moduleRoot, "adapters", `${boundary}.ts`)
        : path.join(outputRoot, dependency.replace(/\.tsx?$/, ".js"));
      destination = path.relative(path.dirname(path.join(outputRoot, file)), target).replace(/\.ts$/, "");
      if (documents && boundary) destination += ".mjs";
      if (!destination.startsWith(".")) destination = `./${destination}`;
      if (!boundary) requestModule(dependency, dependencyNames);
    } else if (!specifier.startsWith("node:") && !["crypto", "path"].includes(specifier)) {
      packages.add(specifier);
      if (documents && specifier === "pdfjs-dist/legacy/build/pdf.mjs") {
        destination = path.relative(path.dirname(path.join(outputRoot, file)), path.join(moduleRoot, "adapters/pdf.mjs"));
      }
    }
    imports.push(`import ${bindings.join(", ")} from ${JSON.stringify(destination)};`);
  }
  const body = ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getFullText(ast)).join("\n");
  return {
    code: `// Generated by scripts/migrate-workflow-nodes.mjs. Do not edit.\n// Source: fastify/vendor/${file}\n${imports.join("\n")}\n${body}\n`.replace(/[\t ]+$/gm, ""),
    sha256: createHash("sha256").update(original).digest("hex"),
  };
}

if (documents) {
  for (const [file, name] of Object.entries({rawText:"readFileRawText",csv:"readCsvRawText",html:"readHtmlRawText",docx:"readDocsFile",pdf:"readPdfFile"})) {
    requestModule("service/worker/readFile/extension/" + file + ".ts", [name]);
  }
  requestModule("global/common/string/markdown.ts", ["htmlTable2Md","matchMdImg"]);
  requestModule("global/common/string/textSplitter.ts", ["splitText2Chunks"]);
} else for (const [, file, name] of nodes) requestModule(base + file, [name]);
// Token counting stays local and uses the original pure worker helper, not a worker pool.
if (!documents) requestModule("service/worker/countGptMessagesTokens/count.ts", ["countPromptTokensInWorker"]);
let pending = true;
while (pending) {
  pending = false;
  for (const [file, names] of requests) {
    const signature = [...names].sort().join(",");
    if (results.get(file)?.signature === signature) continue;
    results.set(file, { ...extract(file, names), signature });
    pending = true;
  }
}
for (const [file, result] of results) {
  const destination = path.join(outputRoot, file.replace(/\.tsx?$/, ".js"));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, result.code);
}
if (documents) {
  const files = [...results].map(([file, r]) => ({file, exports:r.signature.split(","), sha256:r.sha256}));
  writeFileSync(path.join(moduleRoot, "manifest.json"), JSON.stringify({source:"fastify/vendor",files}, null, 2) + "\n");
  writeFileSync(path.join(outputRoot, "LICENSE"), readFileSync(path.join(source, "LICENSE")));
  console.log("Document worker dependencies:", [...packages]);
  process.exit(0);
}
const registry = [
  '// Generated by scripts/migrate-workflow-nodes.mjs. Do not edit.',
  'import type { NodeHandler } from "./types";',
  ...nodes.map(([, file, name]) => `import { ${name} } from "./vendor/${base}${file.replace(/\.tsx?$/, ".js")}";`),
  "export const nodeHandlers = {",
  ...nodes.map(([node, , name]) => `  ${node}: ${name} as unknown as NodeHandler,`),
  "} as const;",
  "export type NodeType = keyof typeof nodeHandlers;",
  "export const nodeTypes = Object.keys(nodeHandlers) as NodeType[];",
].join("\n");
writeFileSync(path.join(moduleRoot, "registry.ts"), registry + "\n");
for (const [node] of nodes) {
  const route = path.join(project, "src/app/api/workflow/nodes", node, "route.ts");
  mkdirSync(path.dirname(route), { recursive: true });
  writeFileSync(route, `// Generated route for the ${node} node.\nimport { createNodeRoute } from "@/server/workflow-nodes/http";\n\nexport const runtime = "nodejs";\nexport const POST = createNodeRoute("${node}");\n`);
}
writeFileSync(path.join(moduleRoot, "manifest.json"), JSON.stringify({
  source: "workflow-zjt/fastify/vendor",
  nodes: nodes.map(([nodeType, file, exportName]) => ({ nodeType, source: base + file, exportName, path: `/api/workflow/nodes/${nodeType}` })),
  files: [...results].map(([file, result]) => ({ file, exports: result.signature.split(","), sha256: result.sha256 })),
  packages: [...packages].sort(),
  boundaries: Object.fromEntries(boundaries),
}, null, 2) + "\n");
writeFileSync(path.join(outputRoot, "LICENSE"), readFileSync(path.join(source, "LICENSE")));
console.log(`Migrated ${nodes.length} handlers, ${results.size} source slices. Packages: ${[...packages].sort().join(", ")}`);
