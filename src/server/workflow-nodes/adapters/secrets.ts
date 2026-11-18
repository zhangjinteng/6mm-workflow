import { unavailable } from "../diagnostics";

/** Never treat encrypted FastGPT form values as successfully decrypted plaintext. */
export function decryptSecret(): never {
  return unavailable("secretDecryption");
}
