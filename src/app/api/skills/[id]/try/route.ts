import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { local, jsonBody, ModelError } from "@/server/capabilities/base";
import { callModel } from "@/server/capabilities/models";
import { audit } from "@/server/capabilities/audit";
import { checked, content } from "@/server/skills/repository";
import { database } from "@/server/model-config/repository";
export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return local(req, async () => {
    const p = z
      .object({
        modelId: z.uuid(),
        revision: z.number().int().positive(),
        version: z.number().int().positive().optional(),
        input: z.string().trim().min(1).max(32000),
      })
      .parse(await jsonBody(req));
    const row = await checked((await ctx.params).id, p.revision);
    const pack = await content(row, p.version);
    const requestId = randomUUID();
    const raw = await callModel("modelChat", {
      modelId: p.modelId,
      messages: [
        { role: "system", content: pack.markdown },
        { role: "user", content: p.input },
      ],
    });
    const result = z
      .object({
        choices: z
          .array(
            z.object({ message: z.object({ content: z.string().nullable() }) }),
          )
          .optional(),
        content: z.array(z.object({ text: z.string().optional() })).optional(),
      })
      .parse(raw);
    const text =
      result.choices?.[0]?.message.content ||
      result.content
        ?.map((b) => b.text)
        .filter(Boolean)
        .join("\n");
    if (!text) throw new ModelError(502, "模型未返回文本");
    await (await database())
      .collection("workflow16080_skill_trials")
      .insertOne({
        skillId: row._id,
        modelId: p.modelId,
        revision: p.revision,
        version: p.version ?? null,
        markdownHash: createHash("sha256").update(pack.markdown).digest("hex"),
        requestId,
        at: new Date(),
      });
    await audit("skillTrial", requestId, "completed");
    return Response.json({ data: { text, requestId } });
  });
}
