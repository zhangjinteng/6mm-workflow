export const workerEnv = { MAX_HTML_TRANSFORM_CHARS: Number(process.env.MAX_HTML_TRANSFORM_CHARS || 1000000) };
export const LogCategories = { INFRA: { WORKER: "worker" } };
// Convert upstream parser failures into failed jobs instead of successful empty documents.
export function getLogger() {
  return { error(message) { throw new Error(message); } };
}
