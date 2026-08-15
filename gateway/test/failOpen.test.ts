import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createGateway } from "../src/server.js";
import { createStubUpstream } from "../src/dev/stubUpstream.js";
import { loadConfig, ConfigError } from "../src/config.js";
import { chooseProvider } from "../src/routing/chooseProvider.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolveListening) => {
    server.listen(0, "127.0.0.1", () => {
      resolveListening((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClosed) => server.close(() => resolveClosed()));
}

function post(port: number, path = "/v1/chat/completions"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "any", messages: [] }),
  });
}

describe("the tracer's forwarding path", () => {
  let stub: Server;
  let upstreamBaseUrl: string;

  before(async () => {
    stub = createStubUpstream();
    upstreamBaseUrl = `http://127.0.0.1:${await listen(stub)}`;
  });

  after(async () => {
    await close(stub);
  });

  it("forwards a chat completion and returns the upstream response unchanged", async () => {
    const gateway = createGateway({
      upstreamBaseUrl,
      port: 0,
      forceRouterError: false,
    });
    const port = await listen(gateway);

    try {
      const response = await post(port);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-stub-upstream"), "true");
      assert.equal(
        response.headers.get("x-gateway-failopen"),
        null,
        "a healthy route must not claim to have failed open",
      );

      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      assert.equal(body.choices[0]?.message.content, "stub upstream response");
    } finally {
      await close(gateway);
    }
  });

  it("still returns the upstream response when the routing seam fails", async () => {
    const gateway = createGateway({
      upstreamBaseUrl,
      port: 0,
      forceRouterError: true,
    });
    const port = await listen(gateway);

    try {
      const response = await post(port);
      assert.equal(response.status, 200, "a routing failure must not cost the request");
      assert.equal(response.headers.get("x-gateway-failopen"), "true");
      assert.equal(response.headers.get("x-stub-upstream"), "true");
    } finally {
      await close(gateway);
    }
  });

  it("returns 502 rather than hanging when the upstream is unreachable", async () => {
    const dead = createStubUpstream();
    const deadPort = await listen(dead);
    await close(dead);

    const gateway = createGateway({
      upstreamBaseUrl: `http://127.0.0.1:${deadPort}`,
      port: 0,
      forceRouterError: false,
    });
    const port = await listen(gateway);

    try {
      const response = await post(port);
      assert.equal(response.status, 502);
    } finally {
      await close(gateway);
    }
  });

  it("does not answer paths outside the one endpoint this plan exposes", async () => {
    const gateway = createGateway({
      upstreamBaseUrl,
      port: 0,
      forceRouterError: false,
    });
    const port = await listen(gateway);

    try {
      const response = await post(port, "/v1/targets");
      assert.equal(response.status, 404);
    } finally {
      await close(gateway);
    }
  });
});

describe("the routing seam", () => {
  const request = { method: "POST", path: "/v1/chat/completions", headers: {}, body: "" };

  it("returns the sole upstream with no rejections", () => {
    const provider = { id: "passthrough", baseUrl: "http://example.invalid" };
    const decision = chooseProvider(request, { providers: [provider] });

    assert.deepEqual(decision.provider, provider);
    assert.equal(decision.boundBy, null);
    assert.deepEqual(decision.rejected, []);
  });

  it("throws rather than inventing a fallback when there is no candidate", () => {
    // The fail-open wrapper owns the fallback; this function owns only the decision.
    assert.throws(() => chooseProvider(request, { providers: [] }));
  });
});

describe("the configuration surface", () => {
  it("requires an upstream base URL", () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });

  it("rejects a port that is not a port", () => {
    assert.throws(
      () => loadConfig({ UPSTREAM_BASE_URL: "http://example.invalid", PORT: "nope" }),
      ConfigError,
    );
  });

  it("reads the fail-open test flag and trims the upstream's trailing slash", () => {
    const config = loadConfig({
      UPSTREAM_BASE_URL: "http://example.invalid/",
      FORCE_ROUTER_ERROR: "1",
    });

    assert.equal(config.upstreamBaseUrl, "http://example.invalid");
    assert.equal(config.forceRouterError, true);
    assert.equal(config.port, 8080);
  });
});
