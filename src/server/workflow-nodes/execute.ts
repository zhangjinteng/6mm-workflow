import { nodeHandlers, type NodeType } from "./registry";
import { invocationDiagnostics } from "./diagnostics";
import type { NodeRequest } from "./schema";
import type { InvocationDiagnostics, JsonRecord } from "./types";

/** Minimal single-call state, deliberately without persistence or secret storage semantics. */
class InvocationVariableState {
  private values: Map<string, unknown>;
  constructor(variables: JsonRecord) {
    this.values = new Map(Object.entries(structuredClone(variables)));
  }
  get(key: string) { return this.values.get(key); }
  async set(key: string, value: unknown) {
    this.values.set(key, value);
    return value;
  }
  toRuntimeRecord() { return Object.fromEntries(this.values); }
  toStoreRecord() { return structuredClone(this.toRuntimeRecord()); }
  clone() { return new InvocationVariableState(this.toRuntimeRecord()); }
}

/** Invoke exactly one migrated handler; capture callbacks and state instead of running a graph. */
export async function executeNode(nodeType: NodeType, input: NodeRequest) {
  const request = structuredClone(input);
  const variableState = new InvocationVariableState(request.variables);
  const runtimeNodes = request.context.runtimeNodes;
  const nodeId = request.context.node.nodeId ?? nodeType;
  const existing = runtimeNodes.findIndex((item) => item.nodeId === nodeId);
  const node = {
    nodeId,
    name: nodeType,
    isEntry: false,
    inputs: [],
    outputs: [],
    ...(existing >= 0 ? runtimeNodes[existing] : {}),
    ...request.context.node,
    flowNodeType: nodeType,
  };
  if (existing >= 0) runtimeNodes[existing] = node;
  else runtimeNodes.push(node);
  const runtimeNodesMap = new Map(runtimeNodes.map((item) => [item.nodeId, item]));
  const events: unknown[] = [];
  const usages: unknown[] = [];
  const diagnostics: InvocationDiagnostics = { missingCapabilities: new Set(), warnings: [] };
  return invocationDiagnostics.run(diagnostics, async () => {
    let result: unknown;
    let error: unknown;
    let failed = false;
    try {
      result = await nodeHandlers[nodeType]({
        ...request.context,
        node: runtimeNodesMap.get(node.nodeId),
        params: request.params,
        variableState,
        runtimeNodes,
        runtimeNodesMap,
        runningAppInfo: { isChildApp: false, ...request.context.runningAppInfo },
        checkIsStopping: () => request.context.stopping,
        workflowStreamResponse: (event: unknown) => events.push(structuredClone(event)),
        usagePush: (items: unknown[]) => usages.push(...structuredClone(items)),
      });
    } catch (caught) {
      failed = true;
      error = caught;
    }
    return {
      failed,
      error,
      missingCapabilities: [...diagnostics.missingCapabilities],
      data: {
        nodeType,
        result,
        variables: variableState.toStoreRecord(),
        runtimeNodes,
        events,
        usages,
        warnings: diagnostics.warnings,
      },
    };
  });
}
