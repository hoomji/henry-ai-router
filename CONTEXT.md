# Provider risk management gateway

The domain language of a gateway that sells provider risk management to teams running
production traffic against hosted AI model providers. This file is a glossary only:
required behavior lives in [`docs/product-specs/`](docs/product-specs/index.md) and
decisions live in [`docs/adr/`](docs/adr/).

## Language

### Routing

**Gateway**:
The service that stands between a customer's application and AI model providers,
choosing which provider serves each request.
_Avoid_: Router, proxy, middleman

**Provider**:
A hosted third party that serves model requests.
_Avoid_: Vendor, upstream, backend

**Fail-open**:
The property that customer traffic still reaches a provider when the gateway's own
decision logic fails.
_Avoid_: Graceful degradation, fallback mode

### Targets

**Target**:
A statement of the outcome a customer needs from a workload, expressed as ceilings and
floors rather than as a routing rule. Never a rule, and never a hint.
_Avoid_: SLO, policy, goal, routing rule

**Workload**:
A customer-named class of traffic that carries its own target. The unit a target applies
to; every customer has one named `default`.
_Avoid_: Route, tenant, tier, environment

**Dimension**:
One measurable quantity a target may constrain. The vocabulary is closed: `p95_ms`,
`cost_per_1k_tokens_usd`, `success_rate`.
_Avoid_: Metric, SLI, criterion

**Objective**:
The single dimension a target names as the quantity to minimize, distinguishing it from
the dimensions that are merely ceilings.
_Avoid_: Optimization goal, primary metric

**Hard dimension**:
The at-most-one dimension a customer marks as never to be breached: the gateway fails the
request instead.
_Avoid_: Strict limit, hard SLO, must-have

**Target document**:
The single versioned document holding a customer's workloads and their targets. The sole
source of truth; the management API and dashboard are views onto it.
_Avoid_: Config, settings, policy file

**Target store**:
The durable home of the target document. Distinct from the document, which is the
customer's statement of intent, and from the configuration surface, which the gateway
operator sets and which never contains targets.
_Avoid_: Database, persistence layer, backing store

**Window**:
The span over which a dimension is measured — trailing 5 minutes or 200 requests,
whichever spans longer.
_Avoid_: Period, interval, lookback

**Insufficient data**:
The value of a dimension for a workload that has not met the window's sample floor.
Distinct from a satisfied target and from a missed one.
_Avoid_: No data, unknown, null

### Infeasibility

**Infeasible by declaration**:
The state of a target that no allowed provider *can* satisfy, determined before any
traffic flows and rejected when the target document is written.
_Avoid_: Invalid, impossible, unsatisfiable

**Unmet**:
The runtime state of a workload whose target no provider mix *has* held, entered after
two consecutive missed windows and left after two consecutive held windows. Distinct from
*infeasible by declaration*, which is knowable without traffic.
_Avoid_: Breached, violated, failing, out of SLO

**Binding reason**:
The explanation a routing decision or infeasibility report must carry: which dimension
bound the choice, and why each candidate provider was not selected.
_Avoid_: Cause, error message, debug info

**Allowed models**:
The customer's required, non-empty list of models the gateway may route to. A blast
radius, not a quality judgement — model quality is not a targetable dimension. An entry is
a bare model name, optionally qualified with a host to pin one.
_Avoid_: Model whitelist, quality floor, preferred models

**Capability floor**:
The best value a dimension can reach for one `(model, host, region, service_tier)` — the
input *infeasible by declaration* checks a target against. Keyed per host, never per
model: the same model on different hosts does not share a floor.
_Avoid_: Benchmark, SLA, provider capability, model spec

**Provenance**:
The tier a capability floor came from and its age, carried on the floor itself and
reported in every rejection. In precedence order: `measured`, `third_party`, `published`,
`declared`. A floor whose tier has expired demotes rather than being used stale.
_Avoid_: Source, origin, confidence, freshness

**Abstain**:
What the feasibility check does when every capability floor for a candidate has expired:
it declines to decide and the write is accepted. Distinct from finding the target
feasible — the gateway is not claiming the target can be met, only that it will not reject
on a number it no longer stands behind.
_Avoid_: Skip, pass, unknown, default-allow

**Decision receipt**:
The record of which capability floors and provenance a feasibility check ran against,
committed with the target document write and keyed by its version. What makes a later
floor correction a comparison rather than a reconstruction. Never part of the target
document, which holds only what the customer authored.
_Avoid_: Audit log, snapshot, history, metadata

### Commerce

**Spend under management**:
The customer's provider spend for traffic the gateway manages, computed from the client's
reported token counts against the *rate card*. The quantity a subscription tier is indexed
to — never a quantity a percentage is taken of, and never money the gateway touches.
_Avoid_: Revenue, GMV, billable volume, spend

**Rate card**:
The versioned schedule of provider unit prices used to convert token counts into *spend
under management*. Changes only forward: a correction never restates a settled invoice.
Distinct from the *capability floor*, which shares its units but is an optimistic claim
that may *abstain* and may be corrected backwards.
_Avoid_: Price list, catalogue, cost table, rates

**Control-plane availability**:
Whether the gateway can serve the status resource and push a routing directive the
client acknowledges. The sole quantity a customer credit attaches to. Not request success,
which belongs to the provider and which *fail-open* exists to preserve.
_Avoid_: Uptime, SLA, availability, gateway health

**Reservation**:
Provider capacity a customer has already paid for under their own contract — Bedrock
Provisioned Throughput, Azure OpenAI PTU — declared to the gateway by the customer. Always
customer-held: the gateway never buys, holds, or resells it.
_Avoid_: Provisioned capacity, committed spend, PTU, allocation

**Addressing a reservation**:
Directing a request at a *reservation* so it consumes capacity already paid for, rather
than falling to on-demand. What idle reserved capacity is idle for want of. Distinct from a
reservation's existence, which the customer declares, and from its size, which the gateway
never verifies.
_Avoid_: Using, utilizing, hitting, consuming

**Usage-decay pricing**:
Retired. Named a business model that does not exist here: nothing decays, and idle
reserved capacity is never priced or reclaimed by the gateway. Superseded by
*reservation-aware routing*, which is a routing input rather than a price.
_Avoid_: Use *reservation-aware routing*
