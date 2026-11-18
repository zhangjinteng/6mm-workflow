import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nodeRequestSchema as envelope } from "../workflow-nodes/schema";
import { local, jsonBody, ModelError } from "./base";
import { documentSchemas, documentNode } from "./documents";
import { callModel, modelSchemas, types } from "./models";
import { resolveIntegration } from "./integrations";
import { moderate } from "./providers";
import { audit, listAudit } from "./audit";

const moderation = z
  .object({ text: z.string().min(1), policyId: z.uuid().optional() })
  .strict();
const logs = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    action: z.string().optional(),
  })
  .strict();
export const schemas: Record<string, z.ZodType> = {
  ...documentSchemas,
  ...modelSchemas,
  moderateText: moderation,
  listAuditLogs: logs,
};

async function review(text: string, requestId: string, policyId?: string) {
  const provider = await resolveIntegration("moderation", policyId);
  if (!provider) throw new ModelError(503, "缺少审核服务");
  const result = await moderate(provider, text);
  await audit("moderateText", requestId, result.decision);
  return result;
}
export function capabilityRoute(name: string) {
  return (request: Request) =>
    local(request, async () => {
      const { params, variables, context } = envelope.parse(
        await jsonBody(request),
      );
      const input = schemas[name].parse(params);
      const requestId = randomUUID();
      let result: unknown;
      try {
        if (name === "moderateText") {
          const p = moderation.parse(input);
          result = await review(p.text, requestId, p.policyId);
        } else if (name === "listAuditLogs") {
          const p = logs.parse(input);
          result = await listAudit(p.limit, p.action);
        } else if (name in modelSchemas) {
          if (name === "modelChat") {
            const chat = modelSchemas.modelChat.parse(input);
            if (chat.censor || chat.policyId) {
              const reviewed = await review(
                chat.messages.map((m) => m.content).join("\n"),
                requestId,
                chat.policyId,
              );
              if (reviewed.decision === "reject")
                throw new ModelError(422, "聊天内容未通过审核");
            }
          }
          result = await callModel(name as keyof typeof types, input);
          await audit(name, requestId, "completed");
        } else result = await documentNode(name, input);
      } catch (error) {
        if (name === "moderateText" || name in modelSchemas)
          await audit(name, requestId, "error").catch(() => undefined);
        throw error;
      }
      return Response.json({
        code: 200,
        data: {
          nodeType: name,
          requestId,
          result,
          variables,
          runtimeNodes: context.runtimeNodes,
          events: [],
          usages:
            result && typeof result === "object" && "usage" in result
              ? [result.usage]
              : [],
          warnings: [],
        },
      });
    });
}
