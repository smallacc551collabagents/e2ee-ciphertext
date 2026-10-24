import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";

// Built once per cold start, reused across warm invocations.
const app = buildApp();
const ready = app.ready();

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await ready;
  app.server.emit("request", req, res);
}
