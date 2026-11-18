/** Keep node-local iteration limits without importing FastGPT service credentials. */
function limit(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback;
}

export const serviceEnv = {
  WORKFLOW_MAX_LOOP_TIMES: limit(process.env.WORKFLOW_MAX_LOOP_TIMES, 100),
  WORKFLOW_PARALLEL_MAX_CONCURRENCY: limit(process.env.WORKFLOW_PARALLEL_MAX_CONCURRENCY, 10),
};
