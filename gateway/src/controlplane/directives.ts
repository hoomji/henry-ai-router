import { listFingerprint } from "./rankedList.js";
import type { RankedList, RankedListDraft } from "./rankedList.js";

/**
 * When a recomputed list becomes a version the connector is told about.
 *
 * Three things make a list worth pushing: the target document changed, a workload entered
 * or left `unmet`, or measured provider state reordered the candidates. This module does
 * not detect those three separately, and that is the design rather than a shortcut — all
 * three are visible in the computed list itself, so comparing the list against the last one
 * published covers them without three change-detection paths that can disagree.
 *
 * The other half of its job is refusing to push. A provider hovering on either side of a
 * target reorders the list on every window, and each reorder would otherwise be a version
 * bump, an SSE frame, and an ack round trip for every connected connector. Debouncing to at
 * most one push per workload per second bounds that: a flapping provider costs one push per
 * second no matter how fast it flaps, and the connector still converges because the last
 * suppressed change is held and published once the window passes.
 *
 * Pure in the same sense as `rankedList.ts`: the clock is an argument and persistence is an
 * injected reader, so the debounce is provable without waiting on wall time.
 */

export interface SchedulerDeps {
  /** `config.pushDebounceMs`: the floor on the interval between two pushes of one workload. */
  readonly debounceMs: number;
  /**
   * The highest version already delivered for a workload, from the store, or `0`.
   *
   * Read rather than remembered because versions are monotonic per (customer, workload)
   * across restarts: a gateway that restarted and began again at 1 would push a connector a
   * version it had already acked, and the connector's only defense is the number.
   */
  readonly readPersistedVersion: (workload: string) => number;
}

interface WorkloadState {
  published: RankedList | null;
  /** `null` until the first push, which is why a first push is never debounced. */
  lastPushedAtMs: number | null;
  /** The most recent change the debounce window suppressed, or `null`. */
  pending: RankedListDraft | null;
  /** Highest version this process has issued, so a slow store read cannot rewind it. */
  issuedVersion: number;
}

export class DirectiveScheduler {
  readonly #debounceMs: number;
  readonly #readPersistedVersion: (workload: string) => number;
  readonly #state = new Map<string, WorkloadState>();

  constructor(deps: SchedulerDeps) {
    this.#debounceMs = deps.debounceMs;
    this.#readPersistedVersion = deps.readPersistedVersion;
  }

  /**
   * Offer a freshly computed list, returning the version to push or `null` for "not now".
   *
   * `null` covers two different situations on purpose. An unchanged list is nothing to say;
   * a changed list inside the debounce window is something to say later, and is retained as
   * `pending` so it is not lost. The caller does not need to tell them apart — in both cases
   * there is nothing to write to a socket.
   */
  offer(draft: RankedListDraft, nowMs: number): RankedList | null {
    const state = this.#stateFor(draft.workload);

    if (state.published !== null && listFingerprint(state.published) === listFingerprint(draft)) {
      // Identical content. Any change we were holding has been superseded by agreement with
      // what is already out there, so drop it rather than pushing a no-op later.
      state.pending = null;
      return null;
    }

    if (state.lastPushedAtMs !== null && nowMs - state.lastPushedAtMs < this.#debounceMs) {
      state.pending = draft;
      return null;
    }

    return this.#publish(state, draft, nowMs);
  }

  /**
   * Publish whatever the debounce held back and is now due.
   *
   * Separate from `offer` because a change that arrives and then stops arriving still has to
   * reach the connector: without this, the last flap of a settling provider would sit in
   * `pending` forever and the connector would run on a list the gateway knows is stale.
   */
  flush(nowMs: number): RankedList[] {
    const published: RankedList[] = [];
    for (const state of this.#state.values()) {
      const pending = state.pending;
      if (pending === null) continue;
      if (state.lastPushedAtMs !== null && nowMs - state.lastPushedAtMs < this.#debounceMs) {
        continue;
      }
      state.pending = null;
      published.push(this.#publish(state, pending, nowMs));
    }
    return published;
  }

  /**
   * Every workload's current published list, in workload order.
   *
   * This is what a connecting connector is sent immediately and what the polling fallback
   * serves. Both must show the version already in force rather than mint a new one: a
   * reconnect is not a change, and treating it as one would make every restart of a
   * connector look like a routing decision.
   */
  current(): RankedList[] {
    const lists: RankedList[] = [];
    for (const state of [...this.#state.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const published = state[1].published;
      if (published !== null) lists.push(published);
    }
    return lists;
  }

  /** The list currently in force for one workload, or `null` if none was ever published. */
  published(workload: string): RankedList | null {
    return this.#state.get(workload)?.published ?? null;
  }

  #publish(state: WorkloadState, draft: RankedListDraft, nowMs: number): RankedList {
    // The store is authoritative across restarts and this process is authoritative within
    // one; taking the maximum means neither a stale read nor a fresh start can hand out a
    // version a connector has already seen.
    const version = Math.max(this.#readPersistedVersion(draft.workload), state.issuedVersion) + 1;
    const list: RankedList = { ...draft, version };
    state.published = list;
    state.issuedVersion = version;
    state.lastPushedAtMs = nowMs;
    state.pending = null;
    return list;
  }

  #stateFor(workload: string): WorkloadState {
    const existing = this.#state.get(workload);
    if (existing !== undefined) return existing;
    const created: WorkloadState = {
      published: null,
      lastPushedAtMs: null,
      pending: null,
      issuedVersion: 0,
    };
    this.#state.set(workload, created);
    return created;
  }
}
