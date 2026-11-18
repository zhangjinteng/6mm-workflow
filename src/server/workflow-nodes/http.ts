import type { NodeType } from "./registry";
import { ApiInputError, parseApiInput } from "./schema";
import { executeNode } from "./execute";

/** Restrict unauthenticated function-debug APIs to local, same-origin callers. */
function isLocalRequest(request: Request) {
  // Next may build request.url with its bind address rather than the incoming Host.
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  let url: URL;
  try {
    url = host ? new URL(`${requestUrl.protocol}//${host}`) : requestUrl;
  } catch {
    return false;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor && !forwardedFor.split(",").every((value) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value.trim()))) return false;
  return true;
}

/** Bind a fixed handler per route; no client-provided module path or remote execution. */
export function createNodeRoute(nodeType: NodeType) {
  return async function POST(request: Request): Promise<Response> {
    if (!isLocalRequest(request)) {
      return Response.json({ code: 403, error: "localOnly", message: "Local same-origin requests only" }, { status: 403 });
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return Response.json({ code: 415, error: "unsupportedMediaType", message: "Use application/json" }, { status: 415 });
    }
    try {
      const body = await parseApiInput(request, nodeType);
      const execution = await executeNode(nodeType, body);
      if (execution.missingCapabilities.length) {
        return Response.json({ code: 501, error: "runtimeUnavailable", capabilities: execution.missingCapabilities, data: execution.data }, { status: 501 });
      }
      if (execution.failed) {
        const message = typeof execution.error === "string" ? execution.error : "Node execution failed; check the node parameters and context";
        return Response.json({ code: 422, error: "nodeExecutionFailed", message, data: execution.data }, { status: 422 });
      }
      return Response.json({ code: 200, data: execution.data });
    } catch (error) {
      if (error instanceof ApiInputError) {
        return Response.json({ code: 400, error: "invalidInput", issues: error.issues }, { status: 400 });
      }
      return Response.json({ code: 500, error: "internalError", message: "Unable to invoke node" }, { status: 500 });
    }
  };
}
