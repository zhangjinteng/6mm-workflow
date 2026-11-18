import { invocationDiagnostics } from "../diagnostics";

export const LogCategories = {
  MODULE: { WORKFLOW: { DISPATCH: "workflow.dispatch", INTERACTIVE: "workflow.interactive" } },
};

/** Collect function warnings in the response without logging submitted secrets. */
export function getLogger() {
  const warn = (message: string) => {
    invocationDiagnostics.getStore()?.warnings.push({ message });
  };
  return { warn, warning: warn, info: warn, error: warn, debug: warn };
}
