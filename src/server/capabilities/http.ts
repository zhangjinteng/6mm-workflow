import { agentSchemas } from "../agent/catalog";
import { agentNode } from "../agent/service";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nodeRequestSchema as envelope } from "../workflow-nodes/schema";
import { local, jsonBody, ModelError } from "./base";
import { documentSchemas, documentNode } from "./documents";
import { callModel, modelSchemas, types } from "./models";
import { resolveIntegration } from "./integrations";
import { moderate } from "./providers";
import { audit, listAudit } from "./audit";

import { sandboxSchemas, sandboxNode } from "../sandbox/nodes";

import {
  compressionSchemas,
  type CompressionNode,
} from "../compression/schema";
import {
  openCompression,
  prepareChat,
  compressionNode,
} from "../compression/service";

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
  ...agentSchemas,
  ...compressionSchemas,
  ...sandboxSchemas,
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
      const usages: unknown[] = [];
      let compression:
        | Awaited<ReturnType<typeof prepareChat>>["compression"]
        | undefined;
      const policy = z
        .object({
          censor: z.boolean().optional(),
          policyId: z.uuid().optional(),
        })
        .parse(
          name === "modelChat" || name in compressionSchemas ? params : {},
        );
      const check =
        policy.censor || policy.policyId
          ? async (text: string) => {
              const reviewed = await review(text, requestId, policy.policyId);
              if (reviewed.decision === "reject")
                throw new ModelError(422, "聊天内容未通过审核");
            }
          : undefined;
      const warnings: string[] = [];
      try {
        if (Object.hasOwn(agentSchemas, name)) {
          result = await agentNode(name, input);
        } else if (name in sandboxSchemas) {
          const started = Date.now();
          let outcome = "error";
          try {
            result = await sandboxNode(
              name as keyof typeof sandboxSchemas,
              input,
            );
            outcome = "completed";
            if (
              result &&
              typeof result === "object" &&
              "exitCode" in result &&
              result.exitCode !== 0
            )
              outcome = result.exitCode === -1 ? "blocked" : "nonzeroExit";
          } catch (error) {
            if (error instanceof ModelError)
              return Response.json(
                { code: error.status, error: error.message, requestId },
                { status: error.status },
              );
            throw error;
          } finally {
            await audit(name, requestId, outcome, Date.now() - started).catch(
              () => warnings.push("调用审计写入失败"),
            );
          }
        } else if (name === "moderateText") {
          const p = moderation.parse(input);
          result = await review(p.text, requestId, p.policyId);
        } else if (name === "listAuditLogs") {
          const p = logs.parse(input);
          result = await listAudit(p.limit, p.action);
        } else if (name in compressionSchemas) {
          result = await compressionNode(
            name as CompressionNode,
            input,
            check,
            usages,
          );
          await audit(name, requestId, "completed");
        } else if (name === "modelChat") {
          const chat = modelSchemas.modelChat.parse(input);
          if (chat.compression?.enabled) {
            const session = await openCompression(
              chat.modelId,
              chat.maxTokens,
              usages,
              chat.temperature,
            );
            const prepared = await prepareChat(chat, session.engine, check);
            compression = prepared.compression;
            result = await session.chat({
              ...chat,
              messages: prepared.messages,
            });
          } else {
            await check?.(chat.messages.map((m) => m.content).join("\n"));
            result = await callModel(name, chat);
          }
          await audit(name, requestId, "completed");
        } else if (name in modelSchemas) {
          result = await callModel(name as keyof typeof types, input);
          await audit(name, requestId, "completed");
        } else result = await documentNode(name, input);
      } catch (error) {
        if (
          name === "moderateText" ||
          name in modelSchemas ||
          name in compressionSchemas
        )
          await audit(name, requestId, "error").catch(() => undefined);
        throw error;
      }
      if (result && typeof result === "object" && "usage" in result)
        usages.push(result.usage);
      return Response.json({
        code: 200,
        data: {
          nodeType: name,
          requestId,
          result,
          ...(compression ? { compression } : {}),
          variables,
          runtimeNodes: context.runtimeNodes,
          events: [],
          usages,
          warnings,
        },
      });
    });
}
