import { z } from "zod";
import manifest from "./manifest.json";
import { schemas } from "./http";
export function capabilities() {
  return manifest.map(({ name, route }) => ({
    name,
    route,
    method: "POST",
    params: z.toJSONSchema(schemas[name], { io: "input" }),
  }));
}
