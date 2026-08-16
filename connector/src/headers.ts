import type { RankedList } from "./types.js";

/**
 * The one response header the connector authors.
 *
 * The gateway cannot write this itself: in normal operation it never sees the response, so
 * only the component at the call site can put anything on it. What made the header worth
 * specifying — that the record lands in logs the customer keeps and we cannot retroactively
 * edit — is unaffected by which of our components writes it.
 */
export const TARGET_UNMET_HEADER = "x-gateway-target-unmet";

/**
 * Add the unmet header when the most recent list says the workload's target is not held.
 *
 * Takes the list rather than a dimension so the header can only ever say what the gateway
 * actually pushed. The connector measures nothing and must not be able to invent an unmet
 * state of its own.
 */
export function withUnmetHeader(
  headers: Readonly<Record<string, string>>,
  list: RankedList | null,
): Readonly<Record<string, string>> {
  if (list === null || list.unmetDimension === null) return headers;
  return { ...headers, [TARGET_UNMET_HEADER]: list.unmetDimension };
}
