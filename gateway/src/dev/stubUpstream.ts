import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

/**
 * A canned-completion upstream, so the tracer is testable with no provider credentials.
 *
 * It answers any POST with the same OpenAI-shaped completion. It is a fixture, not a
 * simulation: M2's load script is where providers gain differing latency and cost.
 */
const CANNED_COMPLETION = {
  id: "chatcmpl-stub",
  object: "chat.completion",
  model: "stub-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "stub upstream response" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 4, total_tokens: 4 },
};

export function createStubUpstream(): Server {
  return createServer((req, res) => {
    // Drain the body: an unread request stream keeps the connection open.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-stub-upstream": "true",
      });
      res.end(JSON.stringify(CANNED_COMPLETION));
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const port = Number(process.env["STUB_PORT"] ?? "8081");
  createStubUpstream().listen(port, () => {
    console.log(`[stub-upstream] listening on http://localhost:${port}`);
  });
}
