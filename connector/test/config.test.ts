import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConnectorOptions } from "../src/config.js";
import { staticFallback } from "../src/index.js";

const complete = {
  GATEWAY_URL: "http://127.0.0.1:8080/",
  GATEWAY_CONNECTOR_TOKEN: "tok",
  CONNECTOR_FALLBACK_BASE_URL: "http://127.0.0.1:8081/",
  CONNECTOR_FALLBACK_MODEL: "sim-a",
};

describe("the connector's configuration surface", () => {
  it("defaults the workload and trims trailing slashes off both URLs", () => {
    const options = loadConnectorOptions(complete);

    assert.equal(options.workload, "default");
    assert.equal(options.gatewayUrl, "http://127.0.0.1:8080");
    assert.equal(options.fallbackBaseUrl, "http://127.0.0.1:8081");
  });

  it("requires the fallback provider, because it is what makes the connector installable first", () => {
    const { CONNECTOR_FALLBACK_BASE_URL: _omitted, ...without } = complete;
    assert.throws(() => loadConnectorOptions(without), ConfigError);
  });

  it("shapes the fallback as a ranked entry so the request path has one code path", () => {
    const fallback = staticFallback(loadConnectorOptions(complete));

    assert.equal(fallback.baseUrl, "http://127.0.0.1:8081");
    assert.equal(fallback.model, "sim-a");
    assert.equal(fallback.reservationId, null);
    assert.equal(fallback.addressingModel, null);
  });
});
