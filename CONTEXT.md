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

**Connector**:
The component the customer installs at their call site. It calls *providers* directly,
obeys the ranked list the *gateway* pushes, acknowledges the directive that opens or closes
an *interception window*, reports token counts, and passes streamed responses through. It
never holds routing policy — the *gateway* decides and the connector obeys, plus one local
rule: on error, try the next provider in the pushed list.
_Avoid_: Client, SDK, agent, shim, sidecar, proxy

**Client**:
Retired as a name for the *connector*. It already meant the customer's own application, a
provider SDK, and any HTTP caller, so it could not identify our component without
ambiguity. Retained here because ADRs
[0004](docs/adr/0004-incidents-included-not-surcharged.md) and
[0005](docs/adr/0005-strain-evidence-detection-internal.md) and the resolutions of
[#4](https://github.com/hoomji/henry-ai-router/issues/4),
[#7](https://github.com/hoomji/henry-ai-router/issues/7) and
[#9](https://github.com/hoomji/henry-ai-router/issues/9) are written in the older
vocabulary; there, "the client" means the *connector*.
_Avoid_: Use *connector*

**Ranked list**:
The ordered sequence of providers a routing *directive* carries for one *workload*, and the
whole of what a *connector* knows about routing. Distinct from a *target*, which the
customer states and the connector never sees, and from a routing rule, which nobody states.
_Avoid_: Mix, policy, route table, provider preferences

**Directive**:
The push through which the *gateway* delivers a *ranked list* to a *connector*, and the
thing a connector acknowledges. The unit of control-plane delivery; the *ranked list* is its
payload. A directive that opens or closes an *interception window* is the same mechanism
carrying the gateway's own address.
_Avoid_: Command, instruction, config push, update

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

### Interception

**Provider strain**:
Evidence that a provider is degrading, aggregated across the customer base and keyed to
`(provider, model, region)`. Global and never customer-specific; an input to declaring an
*interception window*, never an event a customer is told about.
_Avoid_: Incident, outage, provider health, degradation event

**Interception window**:
The span during which a customer's workload has its requests served through the gateway
rather than sent direct, so each request can fail over individually. Keyed per customer and
workload, opened by *provider strain*, and the unit the customer audits. Distinct from
strain, which is the evidence: the same strain opens a window for one customer and not
another.
_Avoid_: Incident, incident window, outage window, failover mode

**Evidence class**:
Whether an *interception window* opened on the customer's own observed traffic
(`observed`) or on cohort evidence before their traffic showed anything (`anticipatory`).
Carried on the window, because the two differ in how much of their basis can be disclosed.
_Avoid_: Trigger type, detection source, confidence

**Acknowledged edge**:
The moment a client confirms the routing directive that opens or closes an *interception
window* — the edge that bounds which traffic was actually intercepted. Distinct from the
declaration, which is when the gateway decided; traffic between the two went direct.
_Avoid_: Incident start, cutover, switch time

**Incident**:
Retired. Named *provider strain* and an *interception window* at once — evidence and
action — and so could not be declared, scoped, or audited without ambiguity. Retained here
because [ADR 0004](docs/adr/0004-incidents-included-not-surcharged.md) is written in the
older vocabulary; there, "the incident window" means the *interception window*.
_Avoid_: Use *provider strain* or *interception window*

### Collective signals

**Cell**:
The `(provider, model, region)` key *provider strain* is aggregated under. Internal, and
never the key of anything disclosed: a disclosed value is keyed no finer than
`(provider, model-family)`. *Region* here is always the provider's serving region and never
the customer's, which is never a key of anything.
_Avoid_: Bucket, partition, group, shard

**Cohort**:
The set of distinct customers contributing to a *cell*. Its size gates what may be disclosed
and is itself never disclosed, which is the whole difficulty: the quantity that licenses a
disclosure cannot be part of one.
_Avoid_: Sample, population, peer group, tenant set

**Strain contribution**:
The provider-observed outcome of one customer request — its status code and its latency —
recorded against a *cell*. A condition of service rather than a setting, and bounded to facts
the provider side already observed: never content, token volumes, per-customer counts, or
identity. Distinct from *provider strain*, which is what the contributions aggregate into.
_Avoid_: Telemetry, data sharing, reporting, signal

**Band**:
The quantized form a cohort-derived value takes when disclosed — `none`, `elevated`,
`severe` — and the only form in which one ever is. Over a *cohort* this size an unquantized
rate is a count, so the coarseness is a privacy property rather than a presentation choice.
_Avoid_: Level, severity, score, bucket

**Shared strain feed**:
Retired. Named a customer-readable surface that does not exist: *provider strain* is never
fed to a customer, it changes their routing, and what the customer sees is a *binding reason*
attached to the resulting decision. A published provider-health product remains an open
decision and would be served from synthetic probes, contributing nothing to and reading
nothing from this aggregate.
_Avoid_: Use *provider strain*, or *binding reason* for what the customer sees

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
