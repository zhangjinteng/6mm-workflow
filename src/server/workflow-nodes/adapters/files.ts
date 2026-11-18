import { unavailable } from "../diagnostics";

/** Existing URLs work unchanged; signing a storage key needs the unmigrated S3 service. */
export function createChatFilePreviewUrlGetter() {
  return async function getPreviewUrl(): Promise<never> {
    return unavailable("chatFileSigning");
  };
}
