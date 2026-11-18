import { database } from "../model-config/repository";
export async function audit(
  action: string,
  requestId: string,
  outcome: string,
) {
  const db = await database();
  await db
    .collection("workflow16080_audit")
    .insertOne({ action, requestId, outcome, at: new Date() });
}
export async function listAudit(limit: number, action?: string) {
  return (await database())
    .collection("workflow16080_audit")
    .find(action ? { action } : {})
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
}
