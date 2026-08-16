import { loadConfig } from "../config.js";
import { createGateway } from "../server.js";

/**
 * The gateway, with an HTTP access log, started as its own process.
 *
 * The single most important claim M1 makes is that the gateway is not in the request path,
 * and the only way to *show* that rather than assert it is to have the gateway write down
 * every request it receives and then find no chat completion among them. `server.ts` has no
 * access log and should not grow one for a demonstration, so the log lives here: this module
 * starts exactly the real gateway, on the real configuration, and only adds a line of stdout
 * per request.
 *
 * A separate process rather than an in-process server because one of the checks is to kill
 * the gateway and watch the sample application carry on. That is not simulable from inside
 * the process being killed.
 *
 * Every line is prefixed `ACCESS ` and is machine-readable, because the verification asserts
 * on it:
 *
 *     ACCESS <epochMs> <METHOD> <path>
 */
const config = loadConfig();
const server = createGateway(config);

server.on("request", (req, res) => {
  const path = (req.url ?? "").split("?")[0] ?? "";
  // Written on arrival rather than on completion: a request that hangs or is aborted still
  // reached the gateway, and an access log that only records finished requests would let
  // exactly that case go unrecorded.
  process.stdout.write(`ACCESS ${Date.now()} ${req.method ?? "?"} ${path}\n`);
  void res;
});

server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(
    `READY gateway http://127.0.0.1:${config.port}` +
      (config.sseDisabled ? " (GATEWAY_SSE_DISABLED=1)" : "") +
      "\n",
  );
});
