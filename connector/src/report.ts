import type { UsageRecord } from "./types.js";

/**
 * Usage reporting: batched, in-memory, and fire-and-forget.
 *
 * The hard constraint that shapes every choice here is that reporting must never be able
 * to slow down or fail a customer's request. `record()` is therefore synchronous and
 * cannot throw, a flush is never awaited by the call path, and a failed POST is discarded
 * rather than retried into a growing queue.
 *
 * The interesting part is that one record serves two consumers with different tolerances
 * for loss, and the buffering differs accordingly.
 *
 * As a *usage* record it computes the bill. Losing one degrades a figure the specification
 * already takes as reported rather than audited, and the most recent minute is the part a
 * customer will actually notice — so the usage queue is bounded and drops **oldest first**.
 *
 * As a *strain contribution* it feeds the collective aggregate, and there drop-oldest is
 * actively wrong. A rate-limit storm is a burst; a burst is exactly what overflows the
 * queue; dropping by age discards the *onset* of the event the cohort exists to detect. It
 * also fails asymmetrically — the customers hit hardest lose the most evidence, so the
 * aggregate would systematically understate severe strain. The strain queue therefore
 * sheds by **sampling rather than by age** (reservoir sampling, below), which preserves
 * the shape of a burst instead of its tail, and it records its own drop rate so the
 * aggregate knows what it is missing.
 */

/** The batch body the gateway's usage endpoint accepts. */
export interface UsageBatch {
  readonly records: readonly UsageRecord[];
  readonly strainDropped: number;
  readonly usageDropped: number;
}

export interface ReporterOptions {
  readonly gatewayUrl: string;
  readonly connectorToken: string;
  /** Flush every ten seconds, or every hundred records, whichever comes first. */
  readonly flushIntervalMs?: number;
  readonly flushAtRecords?: number;
  readonly usageCapacity?: number;
  readonly strainCapacity?: number;
  /** Injected so the shedding policies are testable without a random outcome. */
  readonly random?: () => number;
  /** Injected so tests can observe a batch without standing up a gateway. */
  readonly send?: (batch: UsageBatch) => Promise<void>;
}

export interface ReporterStats {
  readonly usageBuffered: number;
  readonly strainBuffered: number;
  readonly usageDropped: number;
  readonly strainDropped: number;
}

export interface Reporter {
  /** Never throws, never blocks. Safe to call from the request path. */
  record(record: UsageRecord): void;
  /** Sends whatever is buffered now. Resolves even when the POST fails. */
  flush(): Promise<void>;
  stats(): ReporterStats;
  close(): void;
}

/**
 * Whether a record is evidence of provider strain rather than merely of spend.
 *
 * A 429 or 5xx is the signal itself; a transport failure (status `0`) is the same event
 * seen from the other side of a dropped connection; and a 200 that carries rate-limit
 * headers is what lets the aggregate tell an approaching ceiling from a breached one.
 */
export function isStrainEvidence(record: UsageRecord): boolean {
  if (record.statusCode === 0 || record.statusCode === 429 || record.statusCode >= 500) {
    return true;
  }
  return record.rateLimitLimit !== null || record.rateLimitReset !== null;
}

export function createReporter(options: ReporterOptions): Reporter {
  const flushIntervalMs = options.flushIntervalMs ?? 10_000;
  const flushAtRecords = options.flushAtRecords ?? 100;
  const usageCapacity = options.usageCapacity ?? 1_000;
  const strainCapacity = options.strainCapacity ?? 200;
  const random = options.random ?? Math.random;
  const send = options.send ?? postBatch(options.gatewayUrl, options.connectorToken);

  const usage: UsageRecord[] = [];
  const strain: UsageRecord[] = [];
  let usageDropped = 0;
  let strainDropped = 0;
  // Reservoir sampling needs the count of candidates *seen*, not the count retained; it
  // is reset per batch so each report carries a sample of that report's window.
  let strainSeen = 0;
  let closed = false;

  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // The connector lives inside someone else's application. A reporting timer must never be
  // the reason their process refuses to exit.
  timer.unref();

  function admitUsage(record: UsageRecord): void {
    if (usage.length >= usageCapacity) {
      usage.shift();
      usageDropped += 1;
    }
    usage.push(record);
  }

  function admitStrain(record: UsageRecord): void {
    strainSeen += 1;
    if (strain.length < strainCapacity) {
      strain.push(record);
      return;
    }
    // Classic reservoir sampling: the incoming record replaces a uniformly chosen held one
    // with probability capacity/seen, and is otherwise dropped. Every record in the burst
    // — its first as much as its last — ends up equally likely to survive, which is the
    // property drop-oldest destroys.
    const index = Math.floor(random() * strainSeen);
    if (index < strainCapacity) {
      strain[index] = record;
    }
    strainDropped += 1;
  }

  function record(next: UsageRecord): void {
    if (closed) return;
    admitUsage(next);
    if (isStrainEvidence(next)) admitStrain(next);
    if (usage.length >= flushAtRecords) void flush();
  }

  async function flush(): Promise<void> {
    if (usage.length === 0 && strain.length === 0 && usageDropped === 0 && strainDropped === 0) {
      return;
    }

    // A strain record is also a usage record, and the two buffers hold the same objects
    // when nothing has been shed. Sending the union deduplicated by identity is what makes
    // the strain buffer a *retention* policy rather than a second stream: evidence the
    // usage buffer already dropped still reaches the gateway exactly once.
    const batch: UsageBatch = {
      records: [...new Set<UsageRecord>([...usage, ...strain])],
      strainDropped,
      usageDropped,
    };

    usage.length = 0;
    strain.length = 0;
    strainSeen = 0;
    usageDropped = 0;
    strainDropped = 0;

    try {
      await send(batch);
    } catch {
      // Deliberately swallowed and not requeued. A gateway that is down must not turn into
      // an ever-growing buffer inside the customer's application, and a report that never
      // arrives costs a figure the specification already treats as reported, not audited.
    }
  }

  return {
    record,
    flush,
    stats: (): ReporterStats => ({
      usageBuffered: usage.length,
      strainBuffered: strain.length,
      usageDropped,
      strainDropped,
    }),
    close: (): void => {
      closed = true;
      clearInterval(timer);
    },
  };
}

/** The default transport. Separated so `createReporter` stays testable without a socket. */
function postBatch(
  gatewayUrl: string,
  connectorToken: string,
): (batch: UsageBatch) => Promise<void> {
  return async (batch: UsageBatch): Promise<void> => {
    await fetch(`${gatewayUrl}/v1/connector/usage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connectorToken}`,
      },
      body: JSON.stringify(batch),
    });
  };
}
