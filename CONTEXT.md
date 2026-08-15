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
radius, not a quality judgement — model quality is not a targetable dimension.
_Avoid_: Model whitelist, quality floor, preferred models
