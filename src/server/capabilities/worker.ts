import path from "node:path";
import { Worker } from "node:worker_threads";
import { ModelError } from "./base";
type Output = {
  rawText: string;
  formatText?: string;
  imageList?: { uuid: string; mime: string; base64: string }[];
};
const boundedNumber = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const concurrency = boundedNumber(process.env.PARSE_FILE_WORKERS, 4, 1, 32);
const timeoutMs =
  1000 * boundedNumber(process.env.PARSE_FILE_TIMEOUT_SECONDS, 120, 60, 6000);
let active = 0;
export async function runWorker<T = Output>(
  kind: string,
  params: object,
  bytes?: Buffer,
): Promise<T> {
  if (active >= concurrency) throw new ModelError(429, "解析线程繁忙");
  active++;
  try {
    const worker = new Worker(
      /* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ process.cwd(), "workers/document.mjs"),
      {
        workerData: { kind, params, bytes },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        execArgv: [],
      },
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new ModelError(504, "解析超时")),
          timeoutMs,
        );
        worker.once("exit", () => {
          clearTimeout(timeout);
          reject(new ModelError(422, "解析线程已退出"));
        });
        worker.once("error", () =>
          reject(new ModelError(500, "解析线程不可用")),
        );
        worker.once("message", (msg) =>
          msg.error
            ? reject(new ModelError(422, msg.error))
            : resolve(msg.result),
        );
      });
    } finally {
      await worker.terminate();
    }
  } finally {
    active--;
  }
}
