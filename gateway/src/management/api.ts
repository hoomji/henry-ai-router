import type { TargetService } from "../targets/service.js";
import { serializeTargetDocument } from "../targets/document.js";
import { serializeReservationDocument } from "../reservations/document.js";

/**
 * The control-plane HTTP surfaces: the target document and the per-workload status.
 *
 * `management/` is deliberately a sibling of `server.ts` rather than part of it. These
 * surfaces serve no customer model traffic and must be able to fail without touching the
 * data path — when the store is unreadable this whole module answers `503` while requests
 * keep being forwarded.
 *
 * The handler speaks in plain values rather than `node:http` types even though it is
 * allowed to import them. That is not ceremony: it makes every status code below testable
 * by calling a function, which is why the `409` and `422` cases are proven directly rather
 * than through a socket.
 */

export interface ManagementRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface ManagementResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Paths this module owns. `server.ts` asks before touching the data path. */
export function isManagementPath(path: string): boolean {
  return path === "/v1/targets" || path === RESERVATIONS_PATH || STATUS_PATH.test(path);
}

const STATUS_PATH = /^\/v1\/workloads\/([^/]+)\/status$/;
const RESERVATIONS_PATH = "/v1/reservations";

function json(status: number, body: unknown): ManagementResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * The version a `PUT` claims to be replacing.
 *
 * Shared by both documents because the rule is the same for both: a write that does not name
 * the version it replaces is not participating in the optimistic concurrency at all, and
 * accepting one would make the `409` advisory.
 */
function readEnvelope(
  body: string,
): { readonly envelope: Record<string, unknown>; readonly version: number } | ManagementResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body === "" ? "null" : body);
  } catch (error) {
    return json(400, { error: `body is not valid JSON: ${String(error)}` });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json(400, { error: "body must be a JSON object" });
  }

  const envelope = parsed as Record<string, unknown>;
  const rawVersion = envelope["version"];
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0) {
    return json(400, { error: "version is required and must be a non-negative integer" });
  }

  return { envelope, version: rawVersion };
}

const CONFLICT_DETAIL =
  "re-read the document and re-apply your change; PUT is a whole-document replace";

/**
 * `GET`/`PUT /v1/reservations`.
 *
 * A separate resource from `/v1/targets`, not a section of it, for the reason in the
 * Decision Log: a target states an outcome the customer wants and a reservation states a
 * fact about their contract with a provider. Held in one document, a term expiring would
 * change what a target means with no customer write — and the target document is specified
 * as holding only what the customer authored.
 */
function handleReservations(
  request: ManagementRequest,
  service: TargetService,
): ManagementResponse {
  if (service.degraded) {
    return json(503, { error: "target store unavailable", detail: service.storeError });
  }

  if (request.method === "GET") {
    const document = service.reservationDocument();
    // An explicit `null` rather than a synthesized empty list, exactly as `/v1/targets` does:
    // "declared nothing" and "we cannot tell you" must not look alike.
    return json(200, {
      version: service.reservationVersion,
      reservations: document === null ? null : serializeReservationDocument(document),
    });
  }

  if (request.method !== "PUT") return json(405, { error: "method not allowed" });

  const envelope = readEnvelope(request.body);
  if ("status" in envelope) return envelope;

  const result = service.putReservations(envelope.envelope, envelope.version);
  switch (result.status) {
    case 200:
      return "reservations" in result
        ? json(200, {
            version: result.reservations.version,
            reservations: serializeReservationDocument(result.reservations),
          })
        : json(500, { error: "unreachable: reservation write returned a target document" });
    case 409:
      return json(409, {
        error: "version conflict",
        currentVersion: result.currentVersion,
        detail: CONFLICT_DETAIL,
      });
    case 400:
      return json(400, { error: result.message });
    case 422:
      return json(422, result.body);
    case 503:
      return json(503, { error: "target store unavailable", detail: result.message });
  }
}

export function handleManagementRequest(
  request: ManagementRequest,
  service: TargetService,
  nowMs: number = Date.now(),
): ManagementResponse {
  const statusMatch = STATUS_PATH.exec(request.path);
  if (statusMatch !== null) {
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    if (service.degraded) {
      return json(503, { error: "target store unavailable", detail: service.storeError });
    }
    const name = decodeURIComponent(statusMatch[1] ?? "");
    const status = service.status(name, nowMs);
    if (status === null) return json(404, { error: `no such workload: ${name}` });
    return json(200, status);
  }

  if (request.path === RESERVATIONS_PATH) return handleReservations(request, service);

  if (request.path !== "/v1/targets") return json(404, { error: "not found" });

  if (request.method === "GET") {
    const result = service.get();
    if (result.status === 503) {
      return json(503, { error: "target store unavailable", detail: service.storeError });
    }
    const document = "document" in result ? result.document : null;
    // A customer who has stated no targets gets an explicit `null` document with a
    // version, not a synthesized empty one. The spec is emphatic that an unreadable store
    // and a customer with no targets must not look alike, and this is the read half of it.
    return json(200, {
      version: service.version,
      document: document === null ? null : serializeTargetDocument(document),
    });
  }

  if (request.method !== "PUT") return json(405, { error: "method not allowed" });

  // Writes must supply the version they replace. Refusing an unversioned write is what
  // makes the optimistic concurrency real rather than advisory.
  const parsed = readEnvelope(request.body);
  if ("status" in parsed) return parsed;

  const result = service.put(parsed.envelope, parsed.version, nowMs);
  switch (result.status) {
    case 200:
      return json(200, {
        version: result.document.version,
        document: serializeTargetDocument(result.document),
      });
    case 409:
      // Terminal by design: the gateway never retries a rejected write on the client's
      // behalf. The client re-reads and re-decides, because only they know whether their
      // intent still holds against the document that beat them.
      return json(409, {
        error: "version conflict",
        currentVersion: result.currentVersion,
        detail: CONFLICT_DETAIL,
      });
    case 422:
      return json(422, result.body);
    case 400:
      return json(400, { error: result.message });
    case 503:
      return json(503, { error: "target store unavailable", detail: result.message });
  }
}
