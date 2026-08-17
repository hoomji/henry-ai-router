# Technical blueprint: the whole system, all five behaviors

- State: `Proposed` — describes the target architecture, not the current tree. Sections
  after [Status](#status) read as intended end state.
- Owner: henry.tran@uniblock.dev
- Last verified: Unverified. The parts of this document that describe built code are
  restatements of [`gateway-design.md`](gateway-design.md), which is `Verified`; the parts
  that describe unbuilt behaviors have nothing to verify against yet.
- Domain language: [`../../CONTEXT.md`](../../CONTEXT.md)
- Governing spec: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Review trigger: the first commit implementing behavior 2, 3 or 5; the acceptance of any of
  ADRs 0008–0011; or a revision to the governing spec's *Behavior sequence and deferrals*
- Companion: [`../handoff/white-paper.md`](../handoff/white-paper.md) — the argument this
  design serves

## Scope, and how this differs from the gateway design doc

[`gateway-design.md`](gateway-design.md) scopes **one runtime** — `gateway/` — and
explicitly does not design behaviors 2 through 5, whose product decisions were open when it
was written. This document scopes the **whole system**: both runtimes, the control loops
that span them, and where each deferred behavior lands.

The division of labor is strict, because duplicating a fact creates two facts that will
disagree:

- Module layout, the provider adapter contract, the routing seam's signature and purity
  argument, the store's durability table, and the config surface belong to
  [`gateway-design.md`](gateway-design.md). This document links to them and does not restate
  them as fact.
- Required behavior belongs to the [product spec](../product-specs/provider-risk-management-gateway.md).
- Hard-to-reverse trade-offs belong to [`../adr/`](../adr/).
- The top-level component map belongs to [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

What is genuinely this document's own: the control-loop decomposition in section 3, the
system-level invariant list in section 4, the extension points in section 8, and the
system-level rejected alternatives in section 9.

## Status

Everything after this section describes the target architecture. This is the one place that
says what exists.

| Behavior | Target-state content | Status |
|---|---|---|
| 1 — Target-state routing | Declared outcome per workload, declaration-time feasibility, rolling windows, `unmet` state machine, ranked-list push | **Implemented**, six acceptance criteria proven |
| Connector (prerequisite, not a behavior) | Customer-installed component that calls providers directly, obeys the ranked list, relays streams, reports usage | **Implemented**, three criteria proven |
| 4 — Reservation-aware routing | Declared reservation surfaced when unaddressed; eligible traffic routed onto it | **Implemented**, one criterion proven |
| 2 — Strain-triggered interception | Auditable interception window, per-request tag, gateway in the path only inside a window | **Specified, not built.** Needs the gateway to hold a provider credential; `anticipatory` windows need behavior 3 |
| 3 — Collective strain signals | Cross-customer aggregate, banded disclosure, cohort-driven shifts | **Specified, not built.** Deferred on ~10 concurrently connected customers per cell |
| 5 — Semantic-fidelity prompt translation | Prompt adapted on cross-model failover, with an explicit no-faithful-translation fallback | **Specified only in outline.** Deferred behind behavior 2 |
| Pricing model | Flat subscription on spend under management, availability credit, invoice invariance | **Meter implemented; no pricing criterion claimed.** Rate structure open (#22) |
| In-path mode | A connector the gateway operates, same policy core | **Proposed** ([ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md)), undecided |

Two limits qualify every "implemented" above and are not repeated later: every run is
against simulated providers on localhost, and no capability floor has ever been measured.
Details in the spec's
[Delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence).

## 1. Component topology

    ┌─ customer's application ─────────────┐
    │                                      │
    │   call site ── connector ────────────────────────▶ provider  (customer credential)
    │                   │  ▲                │
    └───────────────────┼──┼────────────────┘
                        │  │
         usage reports  │  │  ranked lists + directives (SSE, polling fallback)
                        ▼  │
    ┌─ gateway: control plane ─────────────────────────────────────────┐
    │  connector edge ─▶ usage ingestion ─▶ measurement windows        │
    │  management edge ─▶ target document ─▶ feasibility check         │
    │  routing seam (pure) ─▶ ranked list ─▶ directive scheduler       │
    │  unmet state machine ─▶ status resource + signed notification    │
    │  retained data path (behavior 2 only) ────────────────▶ provider │
    └──────────────────┬───────────────────────────────────────────────┘
                       │
              store (targets, reservations, window summaries, unmet
              state, decision receipts, connector tokens, usage)
                       │
              capability catalogue: measured (in process) +
              generated artifact for the unmeasured tiers

Five components, and what each is authoritative for:

| Component | Authoritative for | Never does |
|---|---|---|
| **Connector** | Making the provider call; relaying streams; the `unmet` response header; reporting usage and strain contributions | Hold routing policy; evaluate a target; hold more than "on error, try the next in the list" |
| **Control plane** | Routing policy; feasibility; measurement; `unmet`; disclosure; the ranked list and its binding reason | Carry traffic in normal operation; hold a provider credential (except in-path mode) |
| **Store** | The target document, the reservation document, `unmet` state, decision receipts, connector identity | Sit on the request path, or be read synchronously while serving one |
| **Capability catalogue** | What a provider *plausibly can* do, per `(model, host, region, service_tier)`, with provenance and age | Serve as a billing rate; be trusted when every tier for a key has expired |
| **Rate card** | Billing rates, forward-only | Be corrected backwards, or abstain |

Two credential boundaries are load-bearing rather than incidental:

- **Provider credentials stay with the customer**
  ([ADR 0010](../adr/0010-provider-credential-custody-stays-with-the-customer.md)). The
  connector reads the credential from the customer's own environment and uses it in a call
  the customer's own process makes. The only proposed exception is in-path mode, where the
  gateway is the endpoint making the upstream call and therefore must hold something.
- **Gateway secrets live in configuration, never in the store.** The notification signing
  secret and the admin token that guards connector minting are neither logged nor returned by
  any endpoint. In the store, every backup, dump, and document read path would become a
  secret-handling path.

## 2. Two runtimes, kept apart on purpose

Both are TypeScript on Node 24 or newer, built with `tsc`, with **zero runtime dependencies
outside the Node standard library**. They share no code and talk only over HTTP.

That separation is a design commitment, not a packaging accident. The connector ships into
someone else's application and must stay small enough that installing it is not a decision;
merging the packages would make it impossible to see when it is growing. The same reasoning
extends inward: the gateway's data path is kept thin enough to reimplement in Rust or Go
without rewriting routing policy or provider adapters, which is what the
[dependency rule](../../ARCHITECTURE.md#components-and-dependency-direction) and its two
declared concessions exist to protect.

## 3. The control loops

The system is five loops with different authorities, latency bounds, and failure modes.
Reading it as one request path is the most common way to misunderstand it.

### 3.1 Declaration-time feasibility — synchronous, at write time

| | |
|---|---|
| **Trigger** | A write to the target document |
| **Input** | The proposed document; capability floors per `(model, host, region, service_tier)` with provenance and age; declared reservations |
| **Authority** | Rejects the write outright |
| **Latency** | Synchronous with the write; no traffic has flowed |
| **Output** | Acceptance plus a committed decision receipt, or a rejection disclosing its own basis |

Three properties are customer-visible and easy to get wrong. Rejection is **biased against
itself** — only when the most optimistic candidate floor fails by more than its own variance.
When every tier for a candidate has expired the check **abstains and the write is accepted**,
because the gateway does not reject a target on the strength of a number it no longer stands
behind. And a **corrected floor never invalidates a live document**: the target stays in
force, the status resource says it was accepted against a since-corrected floor, and only a
customer write changes what the document says.

The decision receipt is what makes a later correction a *comparison* rather than a
reconstruction of a past decision from logs — the same objection the design raises against
reconstructed binding reasons. It lives in a sibling table, never inside the document,
because the document is the customer's statement of intent and fields they did not author
must not appear in it.

### 3.2 The ranked-list push loop — the routing product in normal operation

| | |
|---|---|
| **Trigger** | A target or reservation write, a measurement change, a strain-driven shift (behavior 3) |
| **Input** | The current state snapshot: per-workload rolling windows, the resolved target, live reservations |
| **Authority** | Advisory in the strict sense — the connector obeys, but the gateway cannot force a per-request choice |
| **Latency** | ~5 seconds from committed write to in-force routing |
| **Output** | An ordered provider list with its binding reason, plus a connector acknowledgement |

The list is derived by calling the routing seam repeatedly against the snapshot, not by a
second comparator, so a second implementation of the routing decision cannot come into
existence ([ADR 0006](../adr/0006-routing-authority-stays-gateway-side.md)). Pushes are
debounced per workload.

Two things a reader will otherwise get wrong. **Delivery mode is itself a signal:** a
connector on the polling fallback rather than a pushed stream shows up as a persistently wide
gap between declaration and acknowledgement, and that gap is a degradation the customer would
otherwise never be told about. And **the acknowledged edge, not the declaration, is what
bounds behavior**: traffic between the two went direct.

### 3.3 The measurement and `unmet` loop — the fragile one

| | |
|---|---|
| **Trigger** | Every usage report the connector sends |
| **Input** | Connector-reported outcomes only. In normal operation there is no other input |
| **Authority** | Sets customer-visible state on four surfaces |
| **Latency** | Windows spanning trailing 5 minutes or 200 requests, whichever spans longer; two windows to enter `unmet`, two to leave |
| **Output** | The status resource (authoritative), a signed notification on transitions, the connector-written response header |

This loop is where the architecture's central bet is cashed and where it has already broken
once. Reports must be folded into the measurement windows **at ingestion**; a change that
stops that happening leaves every provider `insufficient_data` forever, makes `unmet`
unreachable, and fails no unit test. Three rules protect it, and all three are consequences
of the same fact rather than separate hygiene:

- One shared status classifier serves the ingestion path and the in-path path, so the two
  classifications cannot drift. It treats the connector's transport-failure encoding as
  provider risk rather than success — the trap being that the encoded value is numerically
  below the error threshold.
- A record naming a provider with no catalogue entry is **dropped as unpriceable**, never
  priced at zero, because a zero rate is indistinguishable from free capacity.
- Only the service's own customer's records are folded in, because the windows carry no
  customer dimension. Folding several customers in would silently average one customer's
  providers into another's target.

Two lookbacks, not one, and they answer different questions: routing and the status resource
read a *trailing* merge of the last three closed windows, while the `unmet` machine judges
only *the window that just closed*. Merging older windows into the `unmet` verdict would keep
judging a recovered workload on windows it had already recovered from, breaking the
deliberate symmetry of two-window entry and two-window exit.

**Exploration is a correctness requirement, not a heuristic.** A provider never chosen can
never be measured, so the seam prefers an unmeasured provider over a measured one — without
which the first provider measured keeps the traffic forever. The consequence for anyone
reading a short run: until every candidate has been measured, the observed split is the
exploration transient and says nothing about whether targets work.

### 3.4 The interception loop — behavior 2, not built

| | |
|---|---|
| **Trigger** | Corroborated evidence of provider strain: banded deviation from that provider's own trailing 24-hour baseline, never an absolute rate |
| **Input** | The internal fine-grained strain aggregate |
| **Authority** | Puts the gateway in the request path for the window's duration; fails individual in-flight requests over |
| **Latency** | Entry fast, exit slow, deliberately asymmetric |
| **Output** | An append-only window record with a binding reason; a mandatory per-request response header |

Interception exists for exactly one thing a directive cannot do: **fail an individual
in-flight request over to another provider.** It follows that it is for *partial* failure. A
fully unavailable provider needs a directive, not the data path — every request would fail
over, so moving the whole workload is both sufficient and cheaper. A model deprecation is
known in advance and is a scheduled directive; no window opens for one.

The edge asymmetry is not the symmetric rule `unmet` uses, and the difference is principled:
`unmet` protects a *report*, where flapping gets the alert muted, while a window is an
*action* that is free, reversible, and whose costs point one way — opening late costs the
customer failed requests, closing late costs only gateway compute. So a window opens on a
single corroborated interval and closes only on sustained recovery, proved by **canary
traffic through the gateway**. Synthetic probes on a gateway-held key measure the wrong
account, since rate limits are scoped per organization; releasing traffic direct to test
would make the customer pay for the experiment with unprotected requests. The consequence to
accept: the tail of every window is mixed, so **interception is a per-request property, not
a per-window one**, and no record may describe a window as an interval in which everything
was intercepted.

Windows open automatically. An operator may force-clear or suppress one and may **never open
one**; every override is recorded with its actor. A human in the opening path would spend the
entire insertion-latency budget, and the incentive that would make automatic opening
untrustworthy has already been removed — no charge depends on a declaration
([ADR 0004](../adr/0004-incidents-included-not-surcharged.md)).

A window whose record cannot be written is **still opened** — customer availability outranks
our own bookkeeping — and the gap is disclosed as an unrecorded window, because a period we
cannot account for and a period in which nothing happened must not look alike.

### 3.5 The reservation loop — behavior 4, built

| | |
|---|---|
| **Trigger** | A declared reservation plus connector telemetry |
| **Input** | The reservation document; observed traffic; the reservation's effective rate |
| **Authority** | A *preference* inside the routing seam — never an override |
| **Latency** | Same window as measurement |
| **Output** | An unaddressed-reservation report naming its call-site cause; routing preference onto eligible capacity |

The preference never beats a hard dimension, never leaves `allowed_models`, and is inert when
no reservation is declared. Whether a term is *live* is a clock question, so it is resolved
by the caller into the state snapshot rather than read inside the seam — which is what let
this behavior land without changing the seam's signature or its purity.

Utilization is computed from the connector's own telemetry, not from the provider, because
the authoritative provider signals do not serve routing: one cloud publishes a utilization
figure that lags 30 seconds to 15 minutes against a 5-minute window, and another publishes
none at all. A read-only cloud credential may be offered as optional corroboration; requiring
it would be a far heavier install than the connector itself.

The reservation lives in **its own resource, not the target document**. A target states an
outcome the customer wants; a reservation states a fact about their contract with a third
party. Holding both in one versioned document would let a term expiring change what a target
means without the customer writing anything.

## 4. System invariants

Each of these spans components, so no single module can be read to check it. The first five
are protected in the built system; the last two are commitments the deferred behaviors must
honor.

1. **Fail-open outranks every other property.** If the control plane is unavailable, unreadable,
   or corrupt, customer traffic still reaches a provider. This applies to our own startup:
   a corrupt store yields passthrough forwarding with a failing management surface, never a
   refusal to boot. It also applies to our own control plane: the management and connector
   edges are siblings of the data path, not part of it, so a control-plane failure cannot
   share a fate with forwarding.
2. **An empty document and an unreadable store must never look alike.** The gateway never
   synthesizes an empty target document, because a corruption would then present as
   deliberate configuration and the customer would never learn their targets had stopped
   applying.
3. **One implementation of the routing decision.** The pushed ranked list and any in-path
   per-request choice come from the same pure function over a state snapshot. The connector
   holds no policy.
4. **Usage ingestion feeds the measurement windows.** See 3.3. This is the invariant most
   likely to be broken silently by a well-meaning change, and the one for which unit tests
   are not sufficient evidence.
5. **The dependency rule holds with exactly two declared concessions.** Nothing in the pure
   layers imports the HTTP surfaces or framework types; the store's SQLite I/O and the
   connector edge's HTTP are confined to one file each, so a data-plane rewrite replaces a
   file rather than a package. Both concessions are textually checkable, which is what lets a
   reviewer tell a concession from drift.
6. **No customer-facing surface reads the internal strain aggregate.** Enforced structurally
   — the wire must not exist, and its existence fails the build rather than a review. Sampling
   outputs for leaks tests the wrong property
   ([ADR 0005](../adr/0005-strain-evidence-detection-internal.md)).
7. **A decision that cannot state its binding reason must not be made.** A routing choice, a
   feasibility rejection, and an interception window each owe the customer the dimension at
   fault, the value, and the reason — produced by the decision itself, never reconstructed
   afterwards.

## 5. Interface surfaces

Endpoints, grouped by which edge serves them. The edges are separate processes' worth of
concern even when co-hosted: management and connector traffic must be able to fail without
touching forwarding.

| Surface | Edge | Notes |
|---|---|---|
| Target document read/write | Management | Versioned; a write must supply the version it replaces, and a mismatch is terminal — the gateway never retries for the client |
| Per-workload status | Management | **The authoritative record** of current state. Carries `unmet`, `insufficient_data`, non-contribution, since-corrected-floor flags, and binding reasons |
| Reservation document read/write | Connector edge | Customer-authored; separate from the target document by design |
| Ranked-list stream | Connector edge | Server-Sent Events with a polling fallback; acknowledgement recorded per directive |
| Usage reports | Connector edge | Batched. Folded into the measurement windows at ingestion — see invariant 4 |
| Connector minting | Admin | Behind an admin token; answers `404` rather than standing unguarded when the token is absent |
| Retained data path | Data path | Forwards to a provider chosen by the routing seam, falling back to the configured upstream when routing throws. Kept for behavior 2, not because it serves traffic |

Three contracts carry more weight than the endpoint list.

**The provider adapter is a pure translation pair** — it describes an upstream call and never
performs it, so the same contract can be re-expressed as a Rust trait or Go interface. Its
per-request cost function exists from the first milestone because both target-state routing
and reservation-aware routing consume it, and retrofitting it would touch every adapter.
Streaming splits along this seam: the connector relays streams from its first day, while the
adapter's chunk transform is needed only when the gateway is mid-stream, which happens inside
an interception window and not before. Contract details in
[`gateway-design.md`](gateway-design.md#provider-adapter-contract-proposed).

**The routing seam returns a decision, not a provider.** It carries the chosen provider, the
dimension that bound the choice, and per-candidate rejection reasons — or, when a hard
dimension cannot be held, an explicit failure that is a routing *outcome* rather than an
error. Infeasibility is a return value, never an exception, which is what keeps the fail-open
wrapper's semantics clean: an exception from the seam means a genuine defect.

**The directive protocol is declare-then-acknowledge.** Both edges are recorded, and the
acknowledged one is what bounds behavior.

## 6. State and durability

Behavior 1 produces four kinds of state, and they get four different answers rather than one
store-everything default. The full table with its reasoning is in
[`gateway-design.md`](gateway-design.md#durability-and-the-target-store-proposed); the shape
matters at system level:

- The **target document** is committed before acknowledgement, because a version the customer
  has seen but the store has not committed makes "single source of truth" untrue. Writes are
  rare, human-driven, and off the data path, so the latency is affordable.
- **Measurement windows** are not durable. Raw samples are derived and cheap to rebuild, and
  persisting a hot rolling window would put the store on the request path. Per-window
  summaries are persisted best-effort, and exist only so several processes can be merged.
- **`unmet` state and its counters** persist best-effort at window close, tolerating loss of
  the last window: nothing acknowledges them, so committed-before-ack buys nothing, and
  losing one window delays an entry by roughly five minutes without ever producing a wrong
  state.
- **Decision receipts** commit in the same transaction as the document, because a committed
  document without its receipt is a decision we cannot audit.

**Restart.** The state machine survives; the samples do not. So a workload can be `unmet`
*and* `insufficient_data` at once — coherent, because the first is a claim about the past and
the second about the present, and the status resource must be able to represent both.
Counters older than about two windows of downtime are discarded while the flag itself is
kept: a half-finished count from three days ago measures nothing, whereas silently clearing
the flag while nobody was watching is the harm this design exists to remove.

**Several processes.** Each keeps its own window in memory and writes a tagged summary at
close; the `unmet` machine evaluates over merged summaries whose close falls in the current
window, pruning as it goes. A crashed or scaled-down process ages out within one window with
no heartbeat, liveness detection, or leader election. Two consequences a reader will
otherwise misread as regressions: the sample floor is workload-wide across merged summaries
rather than per-process, and while a process is down the merged count can legitimately fall
below that floor and report `insufficient_data`.

**Notifications de-duplicate through the same primitive as the document.** The `unmet`
transition is itself a compare-and-set; the process that wins it sends, the others observe the
version move and stay silent, so N processes produce one notification. Retries are bounded and
do not survive a restart, because the status resource is authoritative and a persisted retry
queue would reintroduce the unbounded-queue-during-an-incident failure this design rejected. A
transition first *discovered* after a restart notifies normally — it is a real transition, and
suppressing it would let a deploy swallow an `unmet` entry.

## 7. Scaling, and the gap that is not filled

Load in this architecture is driven by **connector count, not request volume** — which is the
whole point, and also the thing this repository has never sized. The gateway holds an SSE
socket per connector, ingests batched usage reports, keeps in-memory windows per (workload,
provider), and does no per-request work at all in normal operation.

[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) flags the absence explicitly and this
document repeats it rather than softening it: **there is no expected-connector-count
projection, no per-connection memory or CPU budget for the held-open sockets, and no hosting
cost estimate.** Two decisions wait on it — a deployment target, and any pricing rate
grounded in our own cost rather than in competitor comparison.

What can be said without measurement: the store is never read synchronously while serving a
request, so store latency does not enter the request path; the data path reads an in-memory
document copy refreshed by polling, which is why a target change takes about five seconds;
and the push scheduler debounces per workload, so a burst of writes does not become a burst
of pushes.

## 8. Where the deferred behaviors attach

Each has a named prerequisite rather than a date, which is why they are deferrals rather
than a backlog.

**Behavior 3 — collective strain signals.** Gated on approximately ten *concurrently
connected* customers per `(provider, model, region)` cell. The obstacle is commercial, not
technical: a cohort-derived routing change requires corroboration across two signal types or
two disjoint cohorts, and neither is reachable from a handful of contributors — the aggregate
is noise with no population in it to separate a provider's degradation from one customer's
bad afternoon. Note the trigger is *not* the aggregation contract's cohort minimum of twenty,
which binds disclosure and not detection.

**Contribution does not wait for the trigger.** Connectors report strain contributions from
the day the connector exists, because a cohort cannot be built retroactively and the trigger
counts customers concurrently connected — a behavior that begins collecting on the day it is
built can never find its trigger already met. What is deferred is the aggregate and
everything downstream: cohort membership, banding, disclosure, and routing on the result.

Attachment points: a new cross-customer aggregate behind the structural guard of invariant 6;
a disclosure layer that collapses cell keys to `(provider, model-family)` and enforces
one-disclosure-per-cell-per-bucket; and a corroboration gate on ranked-list changes. Note that
corroboration binds a *shift* as strictly as a window, and for the opposite reason from the
window's fast entry: a shift moves all of a workload's traffic with no per-request failover
softening it, so the blunter action does not get the weaker evidence rule.

**Behavior 2 — strain-triggered interception.** Needs the connector (built), the gateway
holding a provider credential (the single reason interception exists — the connector cannot
fail a request over without every provider's credentials, and that is the install burden this
product refuses), and behavior 3 for `anticipatory` windows. Until the cohort trigger is met,
**every window is `observed`** — which must be stated rather than discovered, because a
behavior 2 built as though cohort evidence were available on day one would ship exactly the
reactive posture the product claims to replace.

**Behavior 5 — prompt translation.** Follows behavior 2, because the moment it exists for is
a cross-model failover mid-window. Behavior 1 does not need it: a customer's `allowed_models`
list is their assertion that those models are interchangeable *for that workload*, so the
gateway does not adapt a prompt when moving a request between two models the customer listed.
A customer who does not want a model's output removes it from the list rather than receiving
a translated approximation. Its one hard requirement: it must be able to report that no
faithful translation exists and fall back to the untranslated prompt, never silently alter
intent.

**In-path mode.** If accepted, it attaches as *a connector the gateway operates* — the same
ranked list from the same control plane, the same usage-ingestion path, and no change to the
target document, the feasibility check, the measurement windows, or the `unmet` machine, none
of which are aware of which mode a workload runs in. What changes is who hosts the connector
and who holds the credential. Hard budget is then not a third mechanism but a property in-path
mode makes available, since a gateway already in the path can refuse a call before it is made.
The out-of-path guarantee narrows from a product property to a per-workload one, and ships
behind a named exception so it can be withdrawn
([ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md)).

**Async budget enforcement.** Follows the push-and-reconcile shape of routing: a pushed
snapshot, connector self-enforcement, asynchronous reconciliation over the existing report
channel. Overspend is bounded rather than eliminated —
`report_interval × max_burn_rate`, the same shape of cost as the five-second propagation
bound already accepted for routing
([ADR 0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md)).

## 9. Alternatives rejected at system level

[`gateway-design.md`](gateway-design.md#alternatives-considered) records the module-level
rejections. These are the system-level ones, each with the reason it lost.

- **In-path by default.** Rejected because it makes the gateway a worse single point of
  failure than the providers it manages, adds latency the product was never meant to carry,
  and reintroduces the always-on middleman the non-goals exclude. Kept as a scoped,
  withdrawable exception instead.
- **Connector-side routing policy.** Rejected: two implementations of the routing decision
  would drift, and the second could not produce the authoritative binding reason the spec
  requires.
- **A separate in-path product with its own routing implementation.** Rejected on the same
  ground — one policy core, two hosts.
- **Provider credential custody by default.** Rejected as the easiest onboarding and the worst
  trade available. A vault of customers' provider credentials is a target whose value is
  unrelated to our size; it converts a breach of a control plane that today cannot stop a
  single customer request into a breach that can spend every customer's provider budget; and
  it inverts the product's own retention argument, since a customer whose keys we hold is not
  safe to leave.
- **Per-connector billing.** Rejected: it bills a customer for their own deployment topology,
  punishes horizontal scaling, and makes our revenue a function of their autoscaler. The unit
  is the managed workload ([ADR 0011](../adr/0011-billing-unit-is-the-managed-workload.md)).
- **Per-incident or incident-conditional pricing.** Rejected because the gateway declares the
  window and must not be paid by its own declarations
  ([ADR 0004](../adr/0004-incidents-included-not-surcharged.md)).
- **A third infeasibility state for "our floor was wrong".** Rejected: the two-state vocabulary
  is load-bearing across the status schema, the notification trigger, and the routing seam's
  return type, and a third state would pay that cost again to describe a defect in *our* data
  rather than a property of the customer's workload. It gets a receipt, a status flag, and one
  narrowly targeted notification instead.
- **A customer-derived provider-health feed as a product.** Rejected in that form: it would
  put the network effect's output and the product's largest disclosure surface in one pipe,
  and hand a competitor the value of a customer base they do not have. If a feed is ever
  taken, it is served from gateway-run synthetic probes and carries no contribution from
  anyone — and therefore no anonymization contract at all.
- **Retroactively invalidating live target documents when a floor is corrected.** Rejected: a
  background job that breaks a live configuration because *our* data changed is worse than the
  stale floor it fixes, and only a customer write may change the validity of their single
  source of truth.

## 10. What would falsify this design

Stated so the design is answerable rather than merely coherent.

- **Soft budget is unacceptable to most of the market.** Then the out-of-path bet is wrong at
  the product level, not the mechanism level, and in-path mode becomes the default rather than
  an exception. This is the cheapest thing on the list to test and the most expensive to be
  wrong about (#21).
- **Five-second target propagation is too slow for a real workload.** The bound is a direct
  consequence of polling an in-memory copy rather than reading the store per request; it can
  be tightened, but not to zero without putting the store on the request path.
- **Capability floors cannot be sourced accurately enough to reject a target.** Then
  declaration-time feasibility degrades to permanent abstention and `infeasible_by_declaration`
  becomes decorative, leaving `unmet` as the only real report. The abstention rate is the
  signal to watch, and it is deliberately visible for that reason.
- **Cohort formation never reaches ten customers per cell.** Then behavior 3 never starts,
  behavior 2 ships `observed`-only, and the proactive claim reduces to fast reaction.
- **Per-connector infrastructure cost turns out not to be cheap.** Then the pricing story
  built on "you do not pay for our presence in your path" survives, but the margin under it
  may not. Section 7 is the gap.
