import type { Reservation, ReservationDocument } from "../types.js";

/**
 * The reservation document's wire form, and the only place it is validated.
 *
 * Deliberately a mirror of `targets/document.ts` rather than a shared abstraction over both:
 * the two documents have the same *envelope* (a version, a whole-document replace, a `409`)
 * and nothing else in common, and folding them together would put the customer's stated
 * intent and a fact about their provider contract in one place — which is precisely what the
 * Decision Log separates them to prevent. A term expiring must not change what a target
 * means.
 *
 * Pure by construction: no I/O, no clock, no environment. Term *liveness* is therefore not
 * decided here — it depends on an instant, and the caller supplies that.
 */
export class ReservationDocumentError extends Error {
  /** The offending value or path, quoted back so a rejection is disputable. */
  readonly detail: string | null;

  constructor(message: string, detail: string | null = null) {
    super(detail === null ? message : `${message} (${detail})`);
    this.name = "ReservationDocumentError";
    this.detail = detail;
  }
}

const DOCUMENT_KEYS = ["version", "reservations"] as const;

const RESERVATION_KEYS = [
  "id",
  "host",
  "model",
  "region",
  "sizeUnits",
  "unit",
  "termStartMs",
  "termEndMs",
  "effectiveRatePer1kTokensUsd",
  "addressingModel",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: unknown, field: string, where: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ReservationDocumentError(`${field} must be a non-empty string`, where);
  }
  return raw;
}

function requirePositiveNumber(raw: unknown, field: string, where: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new ReservationDocumentError(
      `${field} must be a finite number greater than zero`,
      `${where}: ${String(raw)}`,
    );
  }
  return raw;
}

function requireInstant(raw: unknown, field: string, where: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new ReservationDocumentError(
      `${field} must be a non-negative integer of epoch milliseconds`,
      `${where}: ${String(raw)}`,
    );
  }
  return raw;
}

function parseReservation(raw: unknown, index: number): Reservation {
  if (!isRecord(raw)) {
    throw new ReservationDocumentError("reservation must be an object", `reservations[${index}]`);
  }

  // An unknown key is an error for the same reason it is in the target document: a field the
  // customer believed they had stated and we silently dropped is the one failure mode a
  // declared document cannot survive, because nothing downstream ever contradicts it. Here
  // the stakes are money — a mistyped `addressingModel` is capacity paid for and never used.
  const where = `reservations[${index}]`;
  for (const key of Object.keys(raw)) {
    if (!(RESERVATION_KEYS as readonly string[]).includes(key)) {
      throw new ReservationDocumentError("unknown key in reservation", `${where}.${key}`);
    }
  }

  const id = requireString(raw["id"], "id", where);
  const termStartMs = requireInstant(raw["termStartMs"], "termStartMs", `${where} ${id}`);
  const termEndMs = requireInstant(raw["termEndMs"], "termEndMs", `${where} ${id}`);

  // A term that ends before it starts is never live, so accepting it would store a
  // reservation that can only ever be reported as unaddressed — a bill with no path to
  // being used, and no signal that the document is at fault.
  if (termEndMs <= termStartMs) {
    throw new ReservationDocumentError(
      "termEndMs must be after termStartMs",
      `${where} ${id}: ${termStartMs} -> ${termEndMs}`,
    );
  }

  const sizeUnits = requirePositiveNumber(raw["sizeUnits"], "sizeUnits", `${where} ${id}`);

  return {
    id,
    host: requireString(raw["host"], "host", `${where} ${id}`),
    model: requireString(raw["model"], "model", `${where} ${id}`),
    region: requireString(raw["region"], "region", `${where} ${id}`),
    sizeUnits,
    unit: requireString(raw["unit"], "unit", `${where} ${id}`),
    termStartMs,
    termEndMs,
    effectiveRatePer1kTokensUsd: requirePositiveNumber(
      raw["effectiveRatePer1kTokensUsd"],
      "effectiveRatePer1kTokensUsd",
      `${where} ${id}`,
    ),
    addressingModel: requireString(raw["addressingModel"], "addressingModel", `${where} ${id}`),
  };
}

/**
 * Parse a whole reservation document at a version the store supplies.
 *
 * The version is an argument rather than a wire field, exactly as it is for the target
 * document: the store decides what version a document is, and a writer's claim about the
 * version belongs to the compare-and-set rather than to the content.
 */
export function parseReservationDocument(raw: unknown, version: number): ReservationDocument {
  if (!isRecord(raw)) {
    throw new ReservationDocumentError("reservation document must be an object");
  }

  for (const key of Object.keys(raw)) {
    if (!(DOCUMENT_KEYS as readonly string[]).includes(key)) {
      throw new ReservationDocumentError("unknown key in reservation document", key);
    }
  }

  const rawReservations: unknown = raw["reservations"];
  if (!Array.isArray(rawReservations)) {
    throw new ReservationDocumentError("reservations must be a list");
  }

  const reservations = rawReservations.map(parseReservation);

  // The identifier is what a connector reports back when it addresses one, so two
  // reservations sharing an id would make the unaddressed-capacity report unattributable.
  const seen = new Set<string>();
  for (const reservation of reservations) {
    if (seen.has(reservation.id)) {
      throw new ReservationDocumentError("reservation id stated twice", reservation.id);
    }
    seen.add(reservation.id);
  }

  return { version, reservations };
}

/** Render a document back to its wire form, field for field with the contract. */
export function serializeReservationDocument(doc: ReservationDocument): unknown {
  return {
    version: doc.version,
    reservations: doc.reservations.map((reservation) => ({
      id: reservation.id,
      host: reservation.host,
      model: reservation.model,
      region: reservation.region,
      sizeUnits: reservation.sizeUnits,
      unit: reservation.unit,
      termStartMs: reservation.termStartMs,
      termEndMs: reservation.termEndMs,
      effectiveRatePer1kTokensUsd: reservation.effectiveRatePer1kTokensUsd,
      addressingModel: reservation.addressingModel,
    })),
  };
}
