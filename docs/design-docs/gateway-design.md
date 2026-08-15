# Gateway design: modules, adapter contract, routing seam

- State: `Proposed`
- Owner: henry.tran@uniblock.dev
- Last verified: Unverified (no implementation exists yet; every claim below is proposed
  design, not observed behavior)
- Domain language: [`../../CONTEXT.md`](../../CONTEXT.md)
- Review trigger: the first commit under `gateway/`, or any revision to the governing
  spec or ExecPlan below
- Governing spec: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Implementation sequence: [`../exec-plans/active/2026-08-14-provider-risk-gateway-tracer.md`](../exec-plans/active/2026-08-14-provider-risk-gateway-tracer.md)

## Problem context

The product spec requires a gateway whose defining promise is provider risk management:
fail-open forwarding, target-state routing, and later incident-only interception,
cross-customer strain signals, and prompt translation. The ExecPlan's Decision Log fixes
the platform: TypeScript on Node.js 24+, inside this repository, with the request data
path kept thin enough to reimplement in Rust or Go later without rewriting routing policy
or provider adapters. This document scopes how the code is shaped to honor those
decisions. It does not restate required behavior (the spec owns that) or sequence the
work (the ExecPlan owns that).

## Goals and non-goals

Goals: a module layout whose seams survive all five spec behaviors; an adapter contract a
future non-TypeScript data plane could honor; a routing seam that is pure policy over a
state snapshot; a config surface that grows without breaking the two-variable tracer.

Non-goals: designing behaviors 2–5 in detail (their product decisions are open); multi-
tenancy and authn — still premature before the tracer. Deployment topology is a partial
exception, noted below.

Persistence is no longer a non-goal at all. Behavior 1, as specified after
[#6](https://github.com/hoomji/henry-ai-router/issues/6), requires a versioned target
document with optimistic concurrency and a per-customer notification secret.
[#13](https://github.com/hoomji/henry-ai-router/issues/13) resolved that M2 ships the real
store rather than an in-memory stand-in, and that the store is designed for concurrent
writers from the first milestone (ADR
[`0002`](../adr/0002-durable-target-store-with-cross-process-concurrency.md)). See
*Durability and the target store* below.

Deployment topology consequently could not be kept fully out of scope: designing for
concurrent writers presumes more than one gateway process. Multi-tenancy and authn remain
non-goals — the store carries a customer key column with a single hardcoded value and no
API surface.

## Module layout (proposed)

    gateway/
      package.json            name "gateway", "type": "module", engines node >= 24
      tsconfig.json
      src/
        server.ts             HTTP surface + fail-open wrapper (the data path)
        types.ts              GatewayRequest, GatewayResponse, Provider, ProviderState,
                              Target, Workload, RoutingDecision
        config.ts             reads and validates the environment/config surface
        routing/
          chooseProvider.ts   pure policy: (request, state) -> RoutingDecision
          stats.ts            rolling windows that produce ProviderState snapshots
        targets/
          document.ts         the target document: parse, validate, version
          store.ts            the target store: durable read/CAS-write, boot load, polling
          feasibility.ts      declaration-time check against the capability catalogue
          unmet.ts            the two-window state machine over merged window summaries
        management/
          api.ts              GET/PUT /v1/targets, GET /v1/workloads/{name}/status
          notify.ts           signed, at-least-once unmet-transition notification
        providers/
          adapter.ts          the ProviderAdapter interface
          passthrough.ts      M1's sole adapter
          capabilities.ts     declared capability floor per model (feasibility input)
        dev/
          stubUpstream.ts     canned-completion upstream for credential-free testing
          load.ts             M2 load script: prints traffic split, measured p95, status

Dependency direction is one-way: `server.ts` and `management/` import routing, targets,
and providers; nothing under `routing/`, `targets/`, or `providers/` imports `server.ts`,
`management/`, `node:http`, or any framework type. That rule is what the Decision Log's
"portable data path" claim rests on, and it is the first thing a reviewer should check in
every gateway PR. `targets/store.ts` is the one deliberate concession: it performs I/O
against `node:sqlite`. It is confined to that module precisely so the rest of `targets/`
stays pure, and so a Rust or Go data plane replaces one file rather than a package.

`management/` is deliberately a sibling of `server.ts` rather than part of it: the
management surfaces are control-plane, serve no customer model traffic, and must be able
to fail without touching the data path. A management outage must never be able to break
forwarding — the fail-open boundary applies to our own control plane too.

## Provider adapter contract (proposed)

An adapter is a pure translation pair, no I/O, no framework types:

    interface ProviderAdapter {
      readonly id: string
      toUpstream(req: GatewayRequest): UpstreamRequest    // method, path, headers, body
      fromUpstream(res: UpstreamResponse): GatewayResponse
      costOf(req: GatewayRequest, res: GatewayResponse): number  // per-request cost estimate
    }

`UpstreamRequest`/`UpstreamResponse` are plain-data shapes (strings, headers record, body
bytes or JSON), so the same contract can be re-expressed as a Rust trait or Go interface.
The actual `fetch` happens in `server.ts`, not in the adapter — adapters describe the
call; the data path performs it. `costOf` exists from M1 (returning a constant for the
passthrough adapter) because target-state routing (M2) and usage-decay pricing (spec
behavior 4) both consume per-request cost, and retrofitting it later would touch every
adapter.

Streaming: the tracer buffers responses. When streaming lands, the adapter contract gains
a chunk-transform function rather than a stream object, keeping adapters pure; this is
noted now so nobody designs adapters around whole-body assumptions.

## Routing seam (proposed)

    chooseProvider(request: GatewayRequest, state: ProviderState): RoutingDecision

- Pure and synchronous: no clock reads, no network, no global state. Everything it may
  consider — rolling p95 per provider, observed cost and success rate, the workload's
  `Target`, incident flags later — arrives inside the `ProviderState` snapshot.
- Snapshots are produced by `routing/stats.ts`, which the data path feeds with
  (provider, latency, cost, outcome) observations after each request completes. Stats
  collection is the only stateful part of routing, and it is write-only from the data
  path's perspective.
- **The return type is a decision, not a provider.** Per
  [#6](https://github.com/hoomji/henry-ai-router/issues/6), both infeasibility reports are
  specified as diagnoses that name why each candidate was rejected, so the binding reason
  must be produced by the decision itself — a reason reconstructed from logs afterwards is
  not trustworthy. Proposed shape:

      type RoutingDecision =
        | { chosen: Provider; bound: Dimension | null; rejected: RejectionReason[] }
        | { chosen: null; failed: { dimension: Dimension; reason: 'hard-dimension' } }

  The second case exists because a `hard` dimension fails the request rather than
  breaching it; that is a routing outcome, not an error, and must not be conflated with a
  defect.
- Infeasibility is a return value, never an exception — and it is two distinct states, not
  one (ADR [`0001`](../adr/0001-declaration-time-vs-observed-infeasibility.md)).
  `infeasible_by_declaration` never reaches this function at all: it is rejected at target
  document write time by `targets/feasibility.ts`, so `chooseProvider` may assume its
  target was satisfiable by *someone* when written. `unmet` is derived by
  `targets/unmet.ts` from the sequence of decisions and observations over windows, not
  decided inside a single call — one request cannot know whether two windows have been
  missed. Keeping both states outside the seam is what lets it stay pure.
  Exceptions from `chooseProvider` remain reserved for genuine defects, which is what
  makes the fail-open wrapper's semantics clean.

## Fail-open forwarding path (proposed)

`server.ts` wraps the seam:

1. Parse the inbound request into a `GatewayRequest`.
2. Call `chooseProvider` inside a try/catch.
3. On success, use the chosen provider's adapter; on throw (or on the test flag
   `FORCE_ROUTER_ERROR=1`), forward to the default upstream (`UPSTREAM_BASE_URL`) with the
   passthrough adapter and set `x-gateway-failopen: true`.
4. Record the observation into `stats.ts` either way, so fail-open traffic still teaches
   the router.

The fail-open default is deliberately the *configured* upstream, not a gateway-chosen
alternative: when our logic is broken we must degrade to exactly what the customer would
have done without us (spec's fail-open boundary). Note the spec's stronger criterion —
"with the gateway *down*, traffic still reaches the provider" — is a deployment concern
(DNS/SDK-level bypass), out of this document's scope and flagged as such.

## Target-state routing loop (proposed)

Behavior 1 is specified in full in the product spec's *Target-state routing in detail*
section; this document only shapes the code that implements it. The vocabulary below
follows that section — it is no longer the two-field `{ p95_ms, cost_per_1k }` sketch that
predated [#6](https://github.com/hoomji/henry-ai-router/issues/6).

A `Target` belongs to a named `Workload`, not to a customer: `allowed_models` (required,
non-empty), zero or more of the three dimensions `p95_ms`, `cost_per_1k_tokens_usd`,
`success_rate`, one `objective`, a `priority` order, and at most one `hard` dimension.
Requests select their workload by the `x-gateway-workload` header, resolved in
`server.ts` before the seam is called, so `chooseProvider` receives an already-resolved
target and never parses headers.

Each snapshot carries, per provider **and per workload**, a rolling window spanning
trailing 5 minutes or 200 requests, whichever is longer. The per-workload split matters:
a shared window would let batch traffic's latency mask an interactive workload's
regression. Below the sample floor a dimension's value is `insufficient_data` — a distinct
value in the snapshot, not a null and not a zero, so the seam cannot accidentally treat an
unmeasured dimension as a satisfied one.

`chooseProvider` projects each dimension per provider for the next request, restricted to
`allowed_models`, and picks the provider minimizing the objective among those holding
every ceiling. When none holds every ceiling, the lowest-priority ceiling yields and the
yielded dimension is reported as `bound`; a `hard` dimension never yields and the request
fails instead.

Anti-oscillation: the choice is sticky within a small hysteresis band (a provider must
beat the incumbent by a margin, proposed 10%, to take over). This is separate from — and
must not be confused with — the two-window hysteresis on the `unmet` state: one damps
provider switching per request, the other damps customer-visible state transitions. The
ExecPlan's ≤20% oscillation criterion measures the first.

## Target document and management surfaces (proposed)

The target document is the single source of truth (spec, #6). `targets/document.ts` owns
parse, validation, and versioning; every read returns a version and every write must
supply the version it replaces, with a mismatch rejected as `409`. Validation rejects
unknown dimension names rather than ignoring them — the vocabulary is closed on purpose,
and silently dropping an unrecognized dimension would let a customer believe they had
stated a target they had not.

`targets/feasibility.ts` runs the declaration-time check on every write, against the
declared capability floor per model in `providers/capabilities.ts`, and returns `422` with
the dimension, the requested value, the best achievable value, and the provider achieving
it. That catalogue is the weakest assumption in this design: it must be maintained by hand
and can drift silently from provider reality. It is named as a gap in the wayfinding map
rather than solved here.

`targets/unmet.ts` holds the two-window state machine, entering `unmet` after two
consecutive missed windows and leaving after two consecutive held windows, symmetric by
design so notifications cannot flap. It evaluates over *merged* window summaries and
persists its state, both of which are specified in the next section.

`management/api.ts` serves the document and the per-workload status resource, which is the
**authoritative** record of current state. `management/notify.ts` posts unmet transitions
with an HMAC signature over the body and bounded retry (~15 minutes), then drops. Dropping
is correct rather than lossy precisely because the status resource is authoritative — a
customer's notification endpoint is often down for the same reason their target is unmet,
and a notification queue that grows without bound during an incident is a worse failure
than a missed notification.

## Durability and the target store (proposed)

Resolved by [#13](https://github.com/hoomji/henry-ai-router/issues/13); the concurrency
choice and its trade-off are recorded in ADR
[`0002`](../adr/0002-durable-target-store-with-cross-process-concurrency.md). The **target
store** is SQLite in WAL mode via Node's built-in `node:sqlite` — one file, three tables,
zero runtime dependencies. It requires Node 24 or newer, which raises the engines floor
from the 20 recorded in the ExecPlan's Decision Log.

Behavior 1 produces three pieces of state, and they get three different answers rather
than one store-everything default:

| State | Durability | Why |
|---|---|---|
| Target document | Committed before ack: `PUT /v1/targets` returns `200` only once the write is durable | Customer-authored and unrecoverable if lost. A version the customer has seen but the store has not committed makes "single source of truth" untrue. Writes are rare, human-driven, and off the data path, so the latency is affordable. |
| Measurement windows | Not durable. In-memory, rebuilt from traffic; a per-window *summary* is persisted at each window close, best-effort | Raw samples are derived and cheap to rebuild, and persisting a hot rolling window would put the store on the request path. Summaries exist only so several processes can be merged. |
| `unmet` state and its two-window counters | Persisted at window close, best-effort, tolerating loss of at most the last window | Customer-visible state reported on three surfaces. Nothing acks it, so committed-before-ack buys nothing; losing one window delays an entry by roughly five minutes and never produces a wrong state. |
| Notification signing secret | Not in the store at all — it stays in the config surface | A credential with a different lifecycle. In the store, every backup, dump, and document read path becomes a secret-handling path. |

**Restart.** The state machine survives; the samples do not. `unmet` and its counters are
restored at boot, so a deploy no longer resets a customer's target state. Two consequences
follow and are customer-visible. First, a workload can be `unmet` *and*
`insufficient_data` at the same time until its window refills — coherent, because "no mix
*has* held the target" is a claim about the past while "we cannot measure it right now" is
a claim about the present, but the status resource must be able to represent both.
Second, counters older than about two windows of wall-clock downtime are discarded while
the `unmet` flag itself is kept: a half-finished count from three days ago measures
nothing and must not combine with one fresh window to force an entry, whereas silently
clearing the flag while nobody was watching is the harm this decision exists to remove.
Leaving `unmet` always happens the specified way — two consecutive held windows.

**Concurrency.** Several gateway processes on one host may write. Optimistic concurrency
is enforced by the store's transactional compare-and-set rather than by a single-writer
assumption, which serves both the `409` on the document and notification de-duplication
with one primitive. `409` is terminal: the gateway never retries a rejected write for the
client, and `PUT` is a whole-document replace, so there is no retry loop in our contract
for two management clients to livelock in. Field-level merge across workloads would let a
dashboard edit and a configuration deploy both succeed, but merge semantics over a
document with cross-workload validation is a design of its own and is not taken here.

**Windows under several processes.** Each process keeps its own rolling window in memory
and writes a summary at window close, tagged with a process identifier and the
window-close timestamp. `targets/unmet.ts` evaluates over the merged summaries whose close
falls in the current window and prunes older rows as it goes, so a crashed or scaled-down
process's contribution ages out within one window with no liveness detection, heartbeat,
or leader election. Two rules follow that a reader will otherwise get wrong: the sample
floor is workload-wide across merged summaries rather than per-process, and while a
process is down the merged count can fall below that floor and report `insufficient_data`
— correct behavior that looks like a regression if the merge rule is not known.

**Notifications.** The `unmet` transition is itself a compare-and-set; the process that
wins it sends the notification and the others observe the version move and stay silent, so
N processes produce one notification. Retries do not survive a restart — the status
resource is authoritative, and a persisted retry queue would reintroduce the
unbounded-queue-during-an-incident failure this design already rejected. A transition
first *discovered* after a restart notifies normally: it is a real transition, and
suppressing it would let a deploy swallow an `unmet` entry.

**Reads on the data path.** The store is never read synchronously while serving a request.
`server.ts` routes on an in-memory copy loaded at boot and refreshed by polling the
document version on a short interval (proposed 5 seconds), swapping the copy when it
moves. A store outage therefore degrades only the control plane — writes fail, status may
go stale — and cannot touch forwarding. This is the same argument that makes `management/`
a sibling of `server.ts`, extended to the store. The consequence to state plainly: a
target change takes effect within about five seconds, and `PUT` returning `200` means
*committed*, not *in force in every process*.

**Boot with an unreadable or corrupt store.** The process starts anyway: it serves the
data path as pure passthrough to `UPSTREAM_BASE_URL`, fails management reads and writes
with `503`, and reports the condition loudly. It never synthesizes an empty document,
because an empty document is indistinguishable from a customer who has stated no targets —
a corruption would then look like deliberate configuration and the customer would never
learn their targets had stopped being applied. Refusing to boot was considered and
rejected: a corrupt control-plane file must not stop customer traffic from reaching a
provider, which is the fail-open boundary applied to our own startup.

## Config surface (proposed)

M1: exactly two environment variables, `UPSTREAM_BASE_URL` and `FORCE_ROUTER_ERROR`.
M2 adds a JSON config file (path via `GATEWAY_CONFIG`) declaring providers
(`{ id, baseUrl, adapter }`), their capability floors, the notification endpoint and
secret, and the target store's file path (overridable by `GATEWAY_STORE_PATH`, following
the same environment-overrides-file rule, so M1 keeps exactly its two variables).
`config.ts` is the only module that reads the environment; everything else
receives parsed config as arguments, so config growth never leaks into routing or
adapters. Environment variables always override file values, keeping the tracer's
two-variable setup working forever.

Targets are deliberately **not** part of this config surface. They live in the target
document behind `PUT /v1/targets`, because #6 made that document the single source of
truth with optimistic concurrency — putting targets in a process-level config file too
would create exactly the second writer that versioning exists to prevent. The config file
says where the store lives; it never says what the targets are.

## Alternatives considered

- Adapters performing their own `fetch`: rejected — it welds I/O to the fastest-changing
  code and breaks data-path portability.
- An async `chooseProvider` that probes providers live: rejected — the Decision Log
  requires routing as a function of a snapshot; live probing belongs in stats collection.
- A web framework (Express/Fastify/Hono): rejected for the tracer — `node:http` plus
  global `fetch` keeps runtime dependencies at zero; revisit only with a Decision Log
  entry in the ExecPlan. Note M2's management surfaces raise the cost of this choice:
  routing, JSON body handling, and status codes must now be written by hand for several
  endpoints rather than one. Revisit if `management/api.ts` starts growing a router.
- Deciding `unmet` inside `chooseProvider`: rejected — a single call cannot know whether
  two windows have been missed, and giving the seam that memory would make it stateful,
  breaking the snapshot purity the Decision Log's portability claim depends on.
- Serving management endpoints from `server.ts`: rejected — control-plane failures would
  share a fate with the forwarding path, contradicting the fail-open boundary.

## Failure modes and operational notes

Stub-upstream death mid-run surfaces as upstream errors passed through unchanged (the
gateway does not synthesize responses). Stats windows are in-memory and reset on restart,
so a restart drops every workload below its sample floor into `insufficient_data` until
the window refills. That is now only a measurement gap, not a state loss: per #13 the
`unmet` state and its counters are persisted and restored at boot, so a customer's target
state no longer resets on deploy. A workload is therefore `unmet` and `insufficient_data`
simultaneously for the first window after a restart — see *Durability and the target
store* for why that combination is correct rather than contradictory.

A store outage cannot affect forwarding, because the data path reads an in-memory copy and
never the store; a corrupt store at boot yields passthrough forwarding with a failing
management surface rather than a refusal to start. The remaining exposure is
control-plane: during a store outage a customer cannot change a target, and the status
resource may be up to one window stale.

Security: the tracer binds localhost and holds no credentials. M2 introduces the first
secret — the per-customer notification signing key — which lives in config, is never
logged, and is never returned by any management endpoint. Anything beyond that is future
work gated on the spec's open decisions.

## Evidence

None yet. Verification for this document means: the `gateway/` tree matches the layout
above; `routing/`, `targets/`, and `providers/` contain no imports of `server.ts`,
`management/`, or `node:http`; `chooseProvider` returns a decision carrying a binding
reason; and the M1/M2 transcripts in the ExecPlan exist. When that check is run, record
the date and move State to `Verified`.

Revision note: 2026-08-15 — resolved
[#13](https://github.com/hoomji/henry-ai-router/issues/13) (durability). Added *Durability
and the target store*; persistence left the non-goal list entirely and deployment topology
became a partial exception; `targets/store.ts` joined the layout; the config surface
gained the store path; the failure-modes note that in-memory windows "must not survive to
a real customer" was replaced by the decision itself. The concurrency choice is recorded
in ADR [`0002`](../adr/0002-durable-target-store-with-cross-process-concurrency.md).

Revision note: 2026-08-15 — reconciled with
[#6](https://github.com/hoomji/henry-ai-router/issues/6), which specified behavior 1 in
full after this document was drafted. Changed: the routing seam's return type, the target
vocabulary, per-workload measurement windows, two new module groups (`targets/`,
`management/`), the config surface, persistence moving off the non-goal list, and three
added rejected alternatives. The fail-open path and adapter contract are unchanged.
