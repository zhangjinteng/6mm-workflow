import { countPromptTokensInWorker } from "../vendor/service/worker/countGptMessagesTokens/count.js";

/** Reuse the original pure o200k counter locally, without the worker pool or API process. */
export async function countPromptTokensBatch(prompts: string[]) {
  return prompts.map((prompt) => countPromptTokensInWorker(prompt));
}
