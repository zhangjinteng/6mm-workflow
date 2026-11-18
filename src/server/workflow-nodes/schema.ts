import { z } from "zod";
import type { NodeType } from "./registry";

const jsonRecord = z.record(z.string(), z.json());
const ioSchema = z.object({ key: z.string().optional(), id: z.string().optional(), value: z.json().optional() }).catchall(z.json());
const runtimeNodeSchema = z.object({
  nodeId: z.string().min(1),
  flowNodeType: z.string(),
  inputs: z.array(ioSchema).default([]),
  outputs: z.array(ioSchema).default([]),
  name: z.string().default("Node"),
  isEntry: z.boolean().default(false),
}).catchall(z.json());

export const nodeRequestSchema = z.object({
  params: jsonRecord.default({}),
  variables: jsonRecord.default({}),
  context: z.object({
    node: z.object({
      nodeId: z.string().min(1).optional(),
      name: z.string().optional(),
      isEntry: z.boolean().optional(),
      inputs: z.array(ioSchema).optional(),
      outputs: z.array(ioSchema).optional(),
    }).catchall(z.json()).default({}),
    runtimeNodes: z.array(runtimeNodeSchema).max(500).default([]),
    runtimeEdges: z.array(jsonRecord).max(2000).default([]),
    query: z.array(jsonRecord).default([]),
    histories: z.array(jsonRecord).default([]),
    lastInteractive: jsonRecord.optional(),
    runningAppInfo: jsonRecord.default({}),
    stopping: z.boolean().default(false),
  }).strict().prefault({}),
}).strict();

const reference = z.tuple([z.string(), z.string().optional()]);
const paramsSchemas: Partial<Record<NodeType, z.ZodType>> = {
  workflowStart: z.object({ userChatInput: z.string().optional() }),
  textEditor: z.object({ system_textareaInput: z.string().optional(), system_addInputParam: jsonRecord.optional() }),
  variableUpdate: z.object({ updateList: z.array(z.object({
    variable: reference,
    renderType: z.enum(["input", "reference"]),
    valueType: z.string().optional(),
    value: z.json().optional(),
    numberOperator: z.enum(["=", "+", "-", "*", "/"]).optional(),
    booleanMode: z.enum(["true", "false", "negate"]).optional(),
    arrayMode: z.enum(["clear", "append", "equal"]).optional(),
  }).passthrough()) }),
  ifElseNode: z.object({ ifElseList: z.array(z.object({
    condition: z.enum(["AND", "OR"]),
    list: z.array(z.object({ variable: z.json(), condition: z.string().optional(), value: z.json().optional(), valueType: z.string().optional() }).passthrough()),
  }).passthrough()) }),
  userSelect: z.object({ description: z.string().optional(), userSelectOptions: z.array(z.object({ key: z.string(), value: z.string() }).passthrough()) }),
  formInput: z.object({ description: z.string().optional(), userInputForms: z.array(z.object({ key: z.string(), type: z.string() }).passthrough()) }),
  parallelRun: z.object({ loopInputArray: z.array(z.json()).max(1000).optional(), childrenNodeIdList: z.array(z.string()).optional(), parallelRunMaxConcurrency: z.number().optional(), parallelRunMaxRetryTimes: z.number().optional() }),
  loopRun: z.object({ loopRunMode: z.enum(["array", "conditional"]).optional(), loopRunInputArray: z.array(z.json()).max(1000).optional(), childrenNodeIdList: z.array(z.string()).optional() }),
  loop: z.object({ loopInputArray: z.array(z.json()).max(1000).optional(), childrenNodeIdList: z.array(z.string()).optional() }),
  datasetConcatNode: z.object({ limit: z.number().finite().nonnegative().optional() }),
};

export type NodeRequest = z.infer<typeof nodeRequestSchema>;

export class ApiInputError extends Error {
  constructor(readonly issues: unknown) {
    super("Invalid request body");
  }
}

/** Validate JSON at the HTTP boundary; do not turn user errors into internal failures. */
export async function parseApiInput(request: Request, nodeType: NodeType): Promise<NodeRequest> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new ApiInputError("Body exceeds 1 MiB");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiInputError("Expected a JSON body");
  }
  const body = nodeRequestSchema.safeParse(json);
  if (!body.success) throw new ApiInputError(body.error.issues);
  const params = paramsSchemas[nodeType]?.safeParse(body.data.params);
  if (params && !params.success) throw new ApiInputError(params.error.issues);
  // Parse the shape without stripping original node parameters.
  return body.data;
}
