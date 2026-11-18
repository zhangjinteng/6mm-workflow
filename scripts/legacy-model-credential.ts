import { createDecipheriv } from "node:crypto";

export type LegacySecret = { version: 1; iv: string; tag: string; ciphertext: string };

/** Only the one-time migration uses the old encryption key; runtime storage is plaintext. */
export function decryptLegacyCredential(secret: LegacySecret, modelId: string, rawKey: string | undefined) {
  if (!rawKey || Buffer.from(rawKey, "base64").length !== 32) throw new Error("迁移需要旧 MODEL_CREDENTIAL_KEY，请保留原值");
  try {
    if (secret.version !== 1) throw new Error("Unsupported version");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(rawKey, "base64"), Buffer.from(secret.iv, "base64"));
    decipher.setAAD(Buffer.from(modelId));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    const apiKey = Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
    if (!apiKey.trim() || /[\r\n]/.test(apiKey) || apiKey.length > 8192) throw new Error("Invalid credential");
    return apiKey;
  } catch { throw new Error("旧凭据解密失败，未输出密钥；请检查原加密密钥与数据完整性"); }
}
