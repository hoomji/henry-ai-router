import { DIMENSION_NAMES } from "../types.js";
import type { AllowedModel, DimensionName, Provider, TargetDocument, Workload } from "../types.js";

/**
 * The target document's wire form, and the only place it is validated.
 *
 * Pure by construction: no I/O, no clock, no environment. The store owns durability and
 * the version number; this module owns what the document is allowed to say. Keeping the
 * two apart is what lets the declaration-time feasibility check and the management API
 * share one parse without sharing a storage assumption.
 *
 * Every rejection here is a rejection of the customer's write. The spec's rule that the
 * dimension vocabulary is *closed* is the reason an unknown key is an error rather than a
 * key we ignore: silently dropping a dimension the customer believed they had stated is
 * the one failure mode a target document cannot survive, because nothing downstream would
 * ever contradict it.
 */
export class TargetDocumentError extends Error {
  /** The offending value or path, quoted back so a rejection is disputable. */
  readonly detail: string | null;

  constructor(message: string, detail: string | null = null) {
    super(detail === null ? message : `${message} (${detail})`);
    this.name = "TargetDocumentError";
    this.detail = detail;
  }
}

/** Wire keys a workload object may carry beyond the dimension names themselves. */
const WORKLOAD_KEYS = ["allowed_models", "objective", "priority", "hard"] as const;

const DOCUMENT_KEYS = ["version", "notify_url", "workloads"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDimensionName(key: string): key is DimensionName {
  return (DIMENSION_NAMES as readonly string[]).includes(key);
}

/**
 * Parse one `allowed_models` entry.
 *
 * A bare name means any host the gateway can reach for that model; `model@host` pins one.
 * The distinction is not cosmetic — the same model served by different hosts measured an
 * 86% spread in p50 latency on a single day (#11) — so a malformed entry is rejected
 * rather than coerced into the bare form, which would silently widen the blast radius the
 * customer drew.
 */
export function parseAllowedModel(entry: string): AllowedModel {
  if (entry === "") {
    throw new TargetDocumentError("allowed_models entry must not be empty");
  }

  const parts = entry.split("@");
  if (parts.length > 2) {
    throw new TargetDocumentError("allowed_models entry may pin at most one host", entry);
  }

  const model = parts[0] ?? "";
  if (model === "") {
    throw new TargetDocumentError("allowed_models entry names no model", entry);
  }

  if (parts.length === 1) {
    return { model, host: null };
  }

  const host = parts[1] ?? "";
  if (host === "") {
    throw new TargetDocumentError("allowed_models entry pins an empty host", entry);
  }

  return { model, host };
}

/** True when `provider` is inside the blast radius `allowed` draws. */
export function providerMatchesAllowed(
  provider: Provider,
  allowed: readonly AllowedModel[],
): boolean {
  return allowed.some(
    (entry) =>
      entry.model === provider.model && (entry.host === null || entry.host === provider.host),
  );
}

function parseAllowedModels(raw: unknown, workloadName: string): readonly AllowedModel[] {
  if (!Array.isArray(raw)) {
    throw new TargetDocumentError("allowed_models must be a list", workloadName);
  }

  // Required and non-empty: it is what bounds the candidate set, and without a bound the
  // declaration-time feasibility check has nothing to check against.
  if (raw.length === 0) {
    throw new TargetDocumentError("allowed_models must not be empty", workloadName);
  }

  return raw.map((entry) => {
    if (typeof entry !== "string") {
      throw new TargetDocumentError("allowed_models entry must be a string", workloadName);
    }
    return parseAllowedModel(entry);
  });
}

function parseDimensionValue(dimension: DimensionName, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new TargetDocumentError(
      `${dimension} must be a finite number greater than zero`,
      String(raw),
    );
  }

  // `success_rate` is the one floor in the vocabulary, and a share above 1 is not a share.
  if (dimension === "success_rate" && raw > 1) {
    throw new TargetDocumentError("success_rate must be a share at or below 1", String(raw));
  }

  return raw;
}

function parsePriority(
  raw: unknown,
  declarationOrder: readonly DimensionName[],
  workloadName: string,
): readonly DimensionName[] {
  // Undeclared, the order is the reverse of the declaration order: highest priority
  // first, so the ceiling stated last is the one that yields first.
  if (raw === undefined) {
    return [...declarationOrder].reverse();
  }

  if (!Array.isArray(raw)) {
    throw new TargetDocumentError("priority must be a list", workloadName);
  }

  const stated: DimensionName[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !isDimensionName(entry)) {
      throw new TargetDocumentError("priority names an unknown dimension", String(entry));
    }
    if (!declarationOrder.includes(entry)) {
      throw new TargetDocumentError("priority names a dimension this workload does not state", entry);
    }
    if (stated.includes(entry)) {
      throw new TargetDocumentError("priority names a dimension twice", entry);
    }
    stated.push(entry);
  }

  // A partial order would leave the yielding rule undetermined for the dimensions it
  // omits, and gateway discretion is exactly what this behavior exists to remove.
  if (stated.length !== declarationOrder.length) {
    throw new TargetDocumentError(
      "priority must order every stated dimension",
      `${stated.length} of ${declarationOrder.length}`,
    );
  }

  return stated;
}

function parseWorkload(name: string, raw: unknown): Workload {
  if (!isRecord(raw)) {
    throw new TargetDocumentError("workload must be an object", name);
  }

  const declarationOrder: DimensionName[] = [];
  const dimensions: Partial<Record<DimensionName, number>> = {};

  // Key order carries meaning: it *is* the declaration order the default priority
  // reverses, which is why the dimensions are inline keys rather than a nested map.
  for (const key of Object.keys(raw)) {
    if (isDimensionName(key)) {
      dimensions[key] = parseDimensionValue(key, raw[key]);
      declarationOrder.push(key);
      continue;
    }
    if (!(WORKLOAD_KEYS as readonly string[]).includes(key)) {
      throw new TargetDocumentError("unknown key in workload", `${name}.${key}`);
    }
  }

  const allowedModels = parseAllowedModels(raw["allowed_models"], name);
  const priority = parsePriority(raw["priority"], declarationOrder, name);

  const statedObjective: unknown = raw["objective"];
  const rawObjective: unknown = statedObjective === undefined ? "none" : statedObjective;
  if (typeof rawObjective !== "string") {
    throw new TargetDocumentError("objective must be a string", name);
  }
  // The objective is what the customer adds *on top of* their ceilings — "hold p95 under
  // 900ms and minimize cost" is the canonical target, not an edge case — so it need only
  // belong to the closed vocabulary, never to the stated dimensions. Requiring it to be
  // stated would force the customer to invent a ceiling for the quantity they are asking
  // the gateway to minimize, which is the underdetermination this field exists to remove.
  if (rawObjective !== "none" && !isDimensionName(rawObjective)) {
    throw new TargetDocumentError(
      "objective must be a dimension in the closed vocabulary or \"none\"",
      rawObjective,
    );
  }
  const objective: DimensionName | "none" = rawObjective === "none" ? "none" : rawObjective;

  const rawHard: unknown = raw["hard"];
  let hard: DimensionName | null = null;
  if (rawHard !== null && rawHard !== undefined) {
    if (typeof rawHard !== "string" || !isDimensionName(rawHard) || !declarationOrder.includes(rawHard)) {
      throw new TargetDocumentError("hard must be a stated dimension", String(rawHard));
    }
    hard = rawHard;
  }

  return { name, allowedModels, dimensions, declarationOrder, objective, priority, hard };
}

/**
 * Parse a whole target document at a version the store supplies.
 *
 * The version is an argument rather than a wire field because the store, not the writer,
 * decides what version a document is; a writer's claim about the version belongs to the
 * compare-and-set, not to the document's content.
 */
export function parseTargetDocument(raw: unknown, version: number): TargetDocument {
  if (!isRecord(raw)) {
    throw new TargetDocumentError("target document must be an object");
  }

  for (const key of Object.keys(raw)) {
    if (!(DOCUMENT_KEYS as readonly string[]).includes(key)) {
      throw new TargetDocumentError("unknown key in target document", key);
    }
  }

  const rawNotifyUrl: unknown = raw["notify_url"];
  let notifyUrl: string | null = null;
  if (rawNotifyUrl !== null && rawNotifyUrl !== undefined) {
    if (typeof rawNotifyUrl !== "string" || !isPostableUrl(rawNotifyUrl)) {
      throw new TargetDocumentError("notify_url must be an http or https URL", String(rawNotifyUrl));
    }
    notifyUrl = rawNotifyUrl;
  }

  const rawWorkloads = raw["workloads"];
  if (!isRecord(rawWorkloads)) {
    throw new TargetDocumentError("workloads must be an object");
  }

  const workloads: Record<string, Workload> = {};
  for (const name of Object.keys(rawWorkloads)) {
    if (name === "") {
      throw new TargetDocumentError("workload name must not be empty");
    }
    workloads[name] = parseWorkload(name, rawWorkloads[name]);
  }

  // Requests that name no workload fall to `default`, so a document without one has no
  // answer for traffic that names nothing.
  if (workloads["default"] === undefined) {
    throw new TargetDocumentError("target document must state a workload named \"default\"");
  }

  return { version, workloads, notifyUrl };
}

function isPostableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function serializeAllowedModel(entry: AllowedModel): string {
  return entry.host === null ? entry.model : `${entry.model}@${entry.host}`;
}

/**
 * Render a document back to its wire form.
 *
 * Dimensions are emitted in `declarationOrder` and `priority` is always emitted
 * explicitly, so a document that round-trips through the store keeps the yielding order
 * the customer stated — a defaulted priority that silently re-derived itself from a
 * reordered map would change which ceiling yields first without a customer write.
 */
export function serializeTargetDocument(doc: TargetDocument): unknown {
  const workloads: Record<string, unknown> = {};

  for (const name of Object.keys(doc.workloads)) {
    const workload = doc.workloads[name];
    if (workload === undefined) {
      continue;
    }

    const wire: Record<string, unknown> = {
      allowed_models: workload.allowedModels.map(serializeAllowedModel),
    };
    for (const dimension of workload.declarationOrder) {
      wire[dimension] = workload.dimensions[dimension];
    }
    wire["objective"] = workload.objective;
    wire["priority"] = [...workload.priority];
    wire["hard"] = workload.hard;

    workloads[name] = wire;
  }

  return { version: doc.version, notify_url: doc.notifyUrl, workloads };
}
