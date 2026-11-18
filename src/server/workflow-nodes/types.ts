export type JsonRecord = Record<string, unknown>;
export type NodeHandler = (props: JsonRecord) => unknown | Promise<unknown>;

export type InvocationDiagnostics = {
  missingCapabilities: Set<string>;
  warnings: { message: string }[];
};
