import { unavailable } from "../diagnostics";

/** The function migration deliberately does not include sub-workflow scheduling. */
export async function runWorkflow(): Promise<never> {
  return unavailable("workflowEngine");
}
