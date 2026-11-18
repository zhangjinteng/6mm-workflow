import { AsyncLocalStorage } from "node:async_hooks";
import type { InvocationDiagnostics } from "./types";

export const invocationDiagnostics = new AsyncLocalStorage<InvocationDiagnostics>();

/** Mark only the invoked missing capability, including errors swallowed by a node. */
export function unavailable(capability: string): never {
  invocationDiagnostics.getStore()?.missingCapabilities.add(capability);
  throw new RuntimeUnavailableError(capability);
}

export class RuntimeUnavailableError extends Error {
  constructor(readonly capability: string) {
    super(`Runtime not migrated: ${capability}`);
    this.name = "RuntimeUnavailableError";
  }
}
