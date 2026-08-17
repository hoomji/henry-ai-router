# Technical blueprint: the whole system and the five behaviors

- State: `Proposed`. This document gives the target architecture. It does not give the
  current tree. Each section after [Status](#status) gives the target architecture.
- Owner: henry.tran@uniblock.dev
- Last verified: Unverified. The parts about built code repeat
  [`gateway-design.md`](gateway-design.md), which is `Verified`. The parts about behaviors 2,
  3 and 5 have no code to verify.
- Specification: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Review trigger: the first commit for behavior 2, 3 or 5; the acceptance of ADR 0008, 0009,
  0010 or 0011; a change to the specification section *Behavior sequence and deferrals*
- Companion: [`../handoff/white-paper.md`](../handoff/white-paper.md)
- Language: ASD-STE100 Simplified Technical English. The terms in *italics* are defined in
  [`../../CONTEXT.md`](../../CONTEXT.md).

## Scope

[`gateway-design.md`](gateway-design.md) has the scope of one runtime. That runtime is
`gateway/`. That document does not design behaviors 2 to 5.

This document has the scope of the whole system. It covers both runtimes, the control loops
between them, and the attachment point of each unbuilt behavior.

The division is strict. A duplicate fact makes two facts, and the two facts then disagree.

- The module layout, the provider adapter contract, the routing function and the durability
  table belong to [`gateway-design.md`](gateway-design.md).
- The necessary behavior belongs to the
  [specification](../product-specs/provider-risk-management-gateway.md).
- A trade-off that is difficult to reverse belongs to an ADR in [`../adr/`](../adr/).
- The component map belongs to [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

Four parts are new in this document: the control loops in section 3, the invariants in
section 4, the attachment points in section 8, and the alternatives in section 9.

## Status

Each section after this one gives the target architecture. This section gives the current
state.

| Behavior | Content | Status |
|---|---|---|
| 1 — Routing to a stated outcome | A *target* for each *workload*, the feasibility check, the *windows*, the *unmet* state machine, the push of a *ranked list* | **Built.** Six criteria are proved |
| The *connector* (a necessary component and not a behavior) | It calls *providers*, obeys the *ranked list*, passes streams through, and reports token counts | **Built.** Three criteria are proved |
| 4 — Routing for a *reservation* | The gateway shows an unaddressed reservation and routes eligible traffic to it | **Built.** One criterion is proved |
| 2 — An *interception window* from *provider strain* | An auditable window, a header on each intercepted response, the gateway in the path only in a window | **Specified. Not built.** The gateway must hold a provider credential. An `anticipatory` *evidence class* needs behavior 3 |
| 3 — Collective signals | The cross-customer aggregate, the disclosure of a *band*, routing from *cohort* evidence | **Specified. Not built.** It waits for approximately 10 customers for each *cell* |
| 5 — Prompt translation | The gateway adapts a prompt for a different model and reports a failure to translate | **In outline only.** It waits for behavior 2 |
| The price model | One flat subscription on *spend under management*, a credit, one invoice for equal traffic | **The meter is built. No criterion is claimed.** The rate structure is open in issue #22 |
| The gateway operates a connector | The same policy and the same *ranked list* | **Proposed.** See [ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md) |

Two limits apply to each "built" item above. Each run uses simulated providers on one host.
No *capability floor* is measured. See
[Delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence).

## 1. The components

    ┌─ the customer's application ─────────┐
    │                                      │
    │   call site ── connector ────────────────────────▶ provider  (customer credential)
    │                   │  ▲                │
    └───────────────────┼──┼────────────────┘
                        │  │
         usage reports  │  │  a directive with a ranked list (SSE, or a poll)
                        ▼  │
    ┌─ the gateway: a control plane ───────────────────────────────────┐
    │  connector surface ─▶ usage input ─▶ windows                     │
    │  management surface ─▶ target document ─▶ feasibility check       │
    │  routing function (pure) ─▶ ranked list ─▶ directive scheduler    │
    │  unmet state machine ─▶ status resource + signed notification     │
    │  retained data path (behavior 2 only) ────────────────▶ provider  │
    └──────────────────┬───────────────────────────────────────────────┘
                       │
              the target store: targets, reservations, window summaries,
              unmet state, decision receipts, connector tokens, usage
                       │
              the capability catalogue: a measured tier in the process,
              and a generated artifact for each other tier

Five components. Each component has one authority.

| Component | The authority | It must not |
|---|---|---|
| **Connector** | The call to the provider, the stream, the *unmet* header, the usage reports and the *strain contribution* | Hold routing policy or examine a *target* |
| **Control plane** | Routing policy, feasibility, measurement, *unmet*, disclosure, the *ranked list* and its *binding reason* | Carry traffic in normal operation, or hold a provider credential |
| **Target store** | The *target document*, the reservation document, *unmet* state, *decision receipts*, connector identity | Be on the request path, or be read during a request |
| **Capability catalogue** | What a provider can do, for each `(model, host, region, service_tier)`, with *provenance* | Be a price, or be used after each tier is stale |
| **Rate card** | Prices, forward only | Change backwards, or *abstain* |

Two credential boundaries are important:

- **The customer keeps the provider credential.** See
  [ADR 0010](../adr/0010-provider-credential-custody-stays-with-the-customer.md). The
  connector reads the credential from the customer's own environment. The customer's own
  process makes the call. The one proposed exception is a connector that the gateway
  operates, because that gateway makes the call.
- **The secrets of the gateway stay in the configuration surface.** The notification key and
  the admin token are not in the *target store*. No log and no endpoint gives them. In the
  store, each backup and each read path becomes a path for a secret.

## 2. Two runtimes

Both runtimes use TypeScript on Node 24 or a later version. Both use `tsc`. Neither has a
runtime dependency outside the Node standard library. They share no code. They communicate
only with HTTP.

This separation is a commitment. The connector installs into the application of another
company. It must stay small. Then the installation is not a decision. One package for both
runtimes hides the growth of the connector.

The same logic applies inside the gateway. The data path stays thin. A later data path in
Rust or Go must not need a new routing policy. The dependency rule and its two declared
concessions protect this property. See
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md#components-and-dependency-direction).

## 3. The five control loops

The system has five loops. Each loop has a different authority, a different time bound and a
different failure. A reader must not read the system as one request path.

### 3.1 The feasibility check — synchronous, at the write

| Item | Value |
|---|---|
| Trigger | A write of the *target document* |
| Input | The new document, the *capability floors*, the declared reservations |
| Authority | It rejects the write |
| Time | Synchronous with the write. No traffic has flowed |
| Output | An acceptance and a *decision receipt*, or a rejection with its basis |

Three properties are visible to the customer:

- The gateway rejects a target with caution. The target must fail the most optimistic
  candidate floor by more than the variance of that floor.
- The check must *abstain* when each tier for a candidate is stale. The gateway then accepts
  the write. The gateway must not reject a target on a number that it no longer supports.
- A correction of a floor must not invalidate a live document. The target stays in force. The
  status resource shows that the floor changed. Only a write from the customer changes the
  document.

The *decision receipt* makes a later correction a comparison. Without the receipt the gateway
must build a past decision from logs again. The receipt is in a separate table. It is never in
the *target document*, because that document holds only the customer's own statement.

### 3.2 The push of a ranked list — the routing product in normal operation

| Item | Value |
|---|---|
| Trigger | A write of a target or a reservation, a change in measurement, or a shift from *provider strain* |
| Input | The state snapshot: the *windows*, the resolved *target*, the live reservations |
| Authority | Advisory. The connector obeys. The gateway cannot decide one request |
| Time | Approximately 5 seconds from the write to the new routing |
| Output | A *ranked list* with its *binding reason*, and an acknowledgement |

The gateway makes the list with repeated calls to the routing function. It does not use a
second comparator. Therefore a second implementation of the routing decision cannot occur. See
[ADR 0006](../adr/0006-routing-authority-stays-gateway-side.md). The gateway debounces the
push for each workload.

Two facts are easy to miss:

- **The delivery mode is a signal.** A connector on the poll fallback shows a large delay
  between the declaration and the acknowledgement. This is a degradation. The customer has no
  other indication of it.
- **The *acknowledged edge* bounds the behavior.** The declaration does not. Traffic between
  the two moments went direct.

### 3.3 The measurement loop and *unmet* — the weak loop

| Item | Value |
|---|---|
| Trigger | Each usage report from the connector |
| Input | The reports from the connector. In normal operation no other input exists |
| Authority | It sets a state that the customer sees on four surfaces |
| Time | A *window* of 5 minutes or 200 requests. Two windows to enter *unmet*, two to leave |
| Output | The status resource, a signed notification, and the header from the connector |

This loop failed one time and nobody saw the failure. The gateway must put each report into
the *windows* at the time of input. A change that stops this leaves each provider at
*insufficient data*. *Unmet* then becomes unreachable, and no unit test fails. Three rules
protect the loop:

- One function classifies the status for both paths. Therefore the two classifications cannot
  become different. The function treats a transport failure as provider risk. The trap is the
  numeric value of that failure, which is below the error threshold.
- The gateway discards a record for a provider with no entry in the catalogue. The gateway
  must not price it at zero, because a zero price looks like free capacity.
- The gateway puts in only the records of its own customer, because a window has no customer
  key. Records from more customers make an average of one customer's providers in another
  customer's target.

**Two lookbacks exist, and they answer different questions.** Routing and the status resource
read the last three closed windows together. The *unmet* machine judges only the window that
closed last. Older windows in the *unmet* verdict judge a recovered workload again. That
breaks the symmetry of the two-window entry and the two-window exit.

**Exploration is necessary and is not a heuristic.** The gateway cannot measure a provider
that it never selects. Therefore the routing function prefers a provider with no measurement.
Without this rule the first measured provider keeps the traffic. One result applies to a short
run. Before the measurement of each candidate, the traffic split is the transient of the
exploration. It shows nothing about a target.

### 3.4 The interception loop — behavior 2, not built

| Item | Value |
|---|---|
| Trigger | Corroborated evidence of *provider strain*, as a *band* against the 24-hour baseline of that provider |
| Input | The internal aggregate at a fine granularity |
| Authority | It puts the gateway in the request path for the window. It moves one request to another provider |
| Time | Entry is fast. Exit is slow. This is deliberate |
| Output | A window record with a *binding reason*, and a header on each intercepted response |

An *interception window* exists for one function. A *directive* cannot move one request that
is in flight to another provider. A window can. Therefore a window is for a partial failure.
Two conditions need no window:

- A provider that is fully unavailable needs a *directive*. Each request fails over, so a
  move of the whole workload is sufficient and cheaper.
- The withdrawal of a model is known in advance. It is a scheduled *directive*.

The asymmetry of the edges is not the symmetric rule of *unmet*. The difference has a reason.
*Unmet* protects a report, and a report that flaps gets muted. A window is an action. It is
free and reversible. A late start costs the customer failed requests. A late end costs only
gateway compute. Therefore a window opens on one corroborated interval. It closes only after a
continuous recovery.

Canary traffic through the gateway proves the recovery. A synthetic probe on a gateway
credential measures the wrong account, because a rate limit applies to one organization. Direct
traffic for a test makes the customer pay for the experiment with unprotected requests. One
result follows. The end of each window is mixed. Therefore an interception is a property of
one request. It is not a property of the whole window. No record can say that the gateway
intercepted all traffic in a window.

A window opens automatically. An operator can clear a window or suppress a window. An operator
must never open one. The gateway records each override with its actor. A human in the path of
the decision uses the whole time budget. [ADR 0004](../adr/0004-incidents-included-not-surcharged.md)
already removed the incentive that makes an automatic start suspect. No charge depends on a
declaration.

The gateway opens a window even when it cannot write the record. The availability of the
customer is more important than our records. The gateway then discloses the gap. A period
without a record and a period without an event must not look the same.

### 3.5 The reservation loop — behavior 4, built

| Item | Value |
|---|---|
| Trigger | A declared *reservation* and the reports from the connector |
| Input | The reservation document, the observed traffic, the effective rate |
| Authority | A preference in the routing function. Never an override |
| Time | The same *window* as the measurement |
| Output | A report of an unaddressed reservation with its cause, and a preference in routing |

The preference never defeats a *hard dimension*. It never leaves *allowed models*. It is
inert without a declared reservation. The term of a reservation is a clock question. Therefore
the caller resolves it into the state snapshot. The routing function keeps its signature and
its purity.

The gateway computes the use of a reservation from the reports of the connector. It does not
use the provider, because the provider signals do not serve routing. One cloud publishes a
figure with a delay of 30 seconds to 15 minutes against a 5-minute window. Another cloud
publishes no figure. A read-only cloud credential is optional. A necessary credential is a
much larger installation than the connector.

A *reservation* is in its own resource. It is not in the *target document*. A target states an
outcome that the customer needs. A reservation states a fact about a contract with a third
party. One document for both permits the end of a term to change a target. The customer then
writes nothing.

## 4. The invariants of the system

Each invariant crosses components. One file cannot show it. The gateway protects invariants 1
to 5 today. Invariants 6 and 7 are commitments for the unbuilt behaviors.

1. ***Fail-open* is more important than each other property.** Customer traffic reaches a
   provider when the control plane is unavailable, unreadable or corrupt. This applies to our
   own start. A corrupt *target store* gives pass-through traffic and a failed management
   surface. The gateway must not refuse to start. This also applies to our own surfaces. The
   management surface and the connector surface are siblings of the data path. A failure in
   them must not stop the traffic.
2. **An empty document and an unreadable store must not look the same.** The gateway never
   makes an empty *target document*. A corruption then looks like a deliberate configuration.
   The customer never learns that the targets stopped.
3. **One implementation of the routing decision exists.** The *ranked list* and each request
   in a window use the same pure function on a state snapshot. The connector holds no policy.
4. **The usage input feeds the *windows*.** See section 3.3. A change breaks this invariant
   easily and silently. Unit tests are not sufficient evidence for it.
5. **The dependency rule holds with two declared concessions.** The pure modules do not import
   an HTTP surface. The SQLite calls and the connector surface are each in one file. Therefore
   a new data path replaces one file. Both concessions are checkable in text. A reviewer can
   then see a concession and a drift as different things.
6. **No customer surface reads the internal aggregate.** The control is structural. The
   connection must not exist, and such a connection fails the build. A test of the outputs
   examines the wrong property. See
   [ADR 0005](../adr/0005-strain-evidence-detection-internal.md).
7. **A decision must give its *binding reason*.** A routing choice, a rejection and an
   *interception window* each owe the customer the dimension, the value and the reason. The
   decision makes the reason. Nothing builds the reason later.

## 5. The interfaces

The surfaces are separate concerns. Management traffic and connector traffic must fail without
an effect on the traffic to a provider.

| Interface | Surface | Notes |
|---|---|---|
| Read and write the *target document* | Management | Versioned. A write gives the version that it replaces. A mismatch is final, and the gateway makes no retry for the caller |
| The status of one *workload* | Management | **The authority** for the current state. It gives *unmet*, *insufficient data*, a corrected floor and each *binding reason* |
| Read and write the reservation document | Connector | The customer writes it. It is separate from the *target document* |
| The stream of a *ranked list* | Connector | Server-Sent Events with a poll fallback. The gateway records each acknowledgement |
| The usage reports | Connector | In batches. The gateway puts them into the *windows* at input. See invariant 4 |
| Make a connector token | Admin | Behind an admin token. Without that token the endpoint gives status 404 and not an open endpoint |
| The retained data path | Data path | It sends a request to a provider from the routing function. It uses the configured provider when the routing logic fails. It exists for behavior 2 |

Three contracts are more important than the list.

**A provider adapter is a pure pair of translations.** An adapter describes a call. An adapter
never makes the call. Therefore a Rust trait or a Go interface can hold the same contract. The
adapter gives a cost for each request from the first milestone, because two behaviors need
that cost. A later change touches each adapter. The stream splits at this contract. The
connector passes a stream through from its first day. The adapter needs a transform for each
chunk only when the gateway is in the stream. That occurs in an *interception window*. See
[`gateway-design.md`](gateway-design.md#provider-adapter-contract-proposed).

**The routing function returns a decision and not a provider.** The decision gives the chosen
provider, the *dimension* that bound the choice, and a reason for each rejected candidate. For
a *hard dimension* the decision gives an explicit failure. That failure is a routing result
and not an error. Infeasibility is a return value and never an exception. Therefore an
exception from the function shows a real defect, and the *fail-open* logic stays clean.

**A *directive* has two edges.** The gateway declares, and the connector acknowledges. The
gateway records both. The *acknowledged edge* bounds the behavior.

## 6. State and durability

Behavior 1 makes four kinds of state. Each kind gets a different answer. The full table is in
[`gateway-design.md`](gateway-design.md#durability-and-the-target-store-proposed).

- The gateway commits the ***target document*** before the acknowledgement. A version that
  the customer saw and the store did not commit makes one source of truth false. A write is
  rare and is off the data path. Therefore the delay is acceptable.
- A ***window*** is not durable. The samples are cheap to build again. A durable rolling
  window puts the *target store* on the request path. A summary of each window is durable at
  the close, as a best effort. A summary exists only for a merge between processes.
- The ***unmet*** state and its counters are durable at the close of a window, as a best
  effort. Nothing acknowledges them. A loss of one window delays an entry by approximately 5
  minutes. It never makes a wrong state.
- A ***decision receipt*** commits in the same transaction as the document. A document without
  its receipt is a decision that we cannot audit.

**A restart.** The state machine continues. The samples do not continue. Therefore a workload
can be *unmet* and at *insufficient data* at the same time. The first is a statement about the
past. The second is a statement about the present. The status resource must show both. The
gateway discards a counter after approximately two windows of downtime. The gateway keeps the
*unmet* flag. An old counter measures nothing. A silent removal of the flag is the damage that
this design prevents.

**More than one process.** Each process keeps its own *window* and writes a summary at the
close. The *unmet* machine reads the merged summaries of the current window. It discards older
rows. A process that stops ages out in one window. The gateway needs no heartbeat and no
leader election. Two results look like a defect and are correct. The sample floor applies to
the whole workload and not to one process. During the downtime of a process the merged count
can fall below that floor and give *insufficient data*.

**Notifications use the same primitive as the document.** The transition to *unmet* is a
compare-and-set. The process that wins sends the notification. The other processes see the new
version and stay silent. Therefore N processes make one notification. A retry is bounded and
does not continue after a restart, because the status resource is the authority. A durable
retry queue makes an unbounded queue during a bad period. A transition that the gateway finds
first after a restart makes a normal notification. It is a real transition. Suppression permits
a deploy to hide it.

## 7. Capacity, and one gap

The connector count drives the load. The request volume does not. This is the purpose of the
architecture. Nobody has measured the result.

The gateway holds one socket for each connector. It receives usage reports in batches. It
keeps a *window* for each workload and provider. It does no work for each request in normal
operation.

[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) states the gap, and this document repeats it.
**No projection of the connector count exists. No memory or CPU budget for one socket exists.
No cost estimate exists.** Two decisions wait for these numbers: a deployment target, and each
rate from our own cost.

Three facts need no measurement. The gateway never reads the *target store* during a request,
so the store latency is not in the request path. The data path reads a copy of the document in
memory and polls for a new version. This is the reason for the 5-second bound. The scheduler
debounces the push for each workload, so many writes do not make many pushes.

## 8. The attachment point of each unbuilt behavior

Each behavior has a named condition and not a date.

**Behavior 3 — collective signals.** It waits for approximately 10 customers for each *cell*.
The obstacle is commercial and not technical. A routing change from *cohort* evidence needs
corroboration from two signal types or two separate cohorts. A small number of contributors
gives neither. The aggregate is then noise. It cannot separate the degradation of a provider
from one bad afternoon of one customer. This condition is not the disclosure minimum of 20
contributors. That minimum bounds a disclosure and not the detection.

**A *strain contribution* does not wait.** A connector sends contributions from its first day.
A cohort cannot be built for a past period. The condition counts the customers that are
connected at the same time. A behavior that starts to collect on its first day can never find
its condition already true. The gateway defers the aggregate and each function after it:
membership of a cohort, the *band*, the disclosure and the routing.

The attachment points are: a cross-customer aggregate behind the structural control of
invariant 6; a disclosure layer that reduces each key to `(provider, model-family)`; and a
corroboration control on each change of a *ranked list*. The corroboration rule binds a change
of a ranked list as strictly as a window, for the opposite reason. A change moves all traffic
of a workload. No failover for each request makes it softer. The blunter action does not get
the weaker rule.

**Behavior 2 — an *interception window*.** It needs the connector, which exists. It needs the
gateway to hold a provider credential. This is the one reason for the behavior: the connector
cannot move a request without each provider credential, and that installation is the burden
that this product refuses. An `anticipatory` *evidence class* needs behavior 3. Before the
condition of behavior 3, each window has the `observed` evidence class. This document states
that fact. A behavior 2 with an assumption of cohort evidence gives the reactive product that
we replace.

**Behavior 5 — prompt translation.** It follows behavior 2, because it is for a failover to a
different model in a window. Behavior 1 does not need it. The list of *allowed models* is the
customer's statement that those models are interchangeable for that *workload*. Therefore the
gateway does not adapt a prompt between two models in that list. A customer removes a model
from the list. The behavior has one hard requirement. It must report that no correct
translation exists and then use the original prompt. It must never change the intent silently.

**A connector that the gateway operates.** It attaches as the same connector logic in the
gateway process. It uses the same *ranked list*, the same control plane and the same usage
input. The *target document*, the feasibility check, the *windows* and the *unmet* machine do
not change. They do not know the mode of a workload. The host of the connector changes. The
holder of the credential changes. A synchronous budget control is then a property of this mode,
because a gateway in the path can refuse a call. The out-of-path property applies to each
workload and not to the product. This mode ships as a named exception, so we can remove it. See
[ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md).

**Asynchronous budget control.** It uses the shape of the routing loop: a pushed snapshot,
local control in the connector, and reconciliation with the usage reports. It bounds the
overspend. It does not remove it. The bound is `report_interval` multiplied by
`max_burn_rate`. This is the shape of the 5-second bound of the routing loop. See
[ADR 0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md).

## 9. The rejected alternatives

[`gateway-design.md`](gateway-design.md#alternatives-considered) gives the module-level
alternatives. This section gives the alternatives for the system.

- **The gateway in the request path for all traffic.** Rejected. It makes the gateway a worse
  single point of failure than the providers. It adds latency. It makes this product the
  always-on service that the non-goals prohibit. A connector that the gateway operates is the
  scoped exception.
- **Routing policy in the connector.** Rejected. Two implementations become different, and the
  second cannot make the authoritative *binding reason*.
- **A separate product with its own routing implementation.** Rejected for the same reason.
  One policy core, two hosts.
- **Custody of each provider credential.** Rejected. It is the easiest installation and the
  worst trade. A store of customer credentials is a target. Its value does not depend on our
  size. It changes a failure of our control plane into a failure that can spend the budget of
  each customer. It also inverts our own retention argument, because a customer cannot leave
  us easily.
- **A price for each connector.** Rejected. It bills a customer for their own deployment. It
  penalizes a horizontal scale. It makes our revenue a function of their autoscaler. The unit
  is the managed *workload*. See
  [ADR 0011](../adr/0011-billing-unit-is-the-managed-workload.md).
- **A charge for each *interception window*.** Rejected. The gateway declares the window and
  must not be paid by its own declarations. See
  [ADR 0004](../adr/0004-incidents-included-not-surcharged.md).
- **A third state for infeasibility.** Rejected. The two-state vocabulary carries the status
  schema, the notification trigger and the return type of the routing function. A third state
  pays that cost again for a defect in our own data. A *decision receipt*, a flag and one
  notification are sufficient.
- **A published health product from customer contributions.** Rejected in that form. It puts
  the output of the network effect and the largest disclosure surface in one place. It gives a
  competitor the value of a customer base that they do not have. A published product must use
  synthetic probes. It then reads nothing from this aggregate.
- **Automatic invalidation of a live *target document* after a correction of a floor.**
  Rejected. A job that breaks a live configuration for a change in our own data is worse than
  the stale floor. Only a write from the customer changes the document.

## 10. What can prove this design wrong

This section makes the design answerable.

- **The market refuses an asynchronous budget control.** The central choice is then wrong at
  the product level. A connector that the gateway operates becomes the default. This is the
  cheapest item to test and the most expensive item to get wrong. It is issue #21.
- **The 5-second bound is too slow for a real workload.** The bound is a result of the poll of
  a copy in memory. We can make it smaller. We cannot make it zero without the *target store*
  on the request path.
- **A *capability floor* cannot be accurate.** The feasibility check then must *abstain*
  always. *Infeasible by declaration* becomes decorative, and *unmet* is the only report. The
  rate of abstention is the signal, and it is visible for this reason.
- **A *cohort* never reaches 10 customers for a *cell*.** Behavior 3 then never starts.
  Behavior 2 gives only the `observed` evidence class. The product then gives a fast reaction
  and not a prevention.
- **The cost for each connector is not low.** The promise about the request path stays true.
  The margin can fail. Section 7 is the gap.
