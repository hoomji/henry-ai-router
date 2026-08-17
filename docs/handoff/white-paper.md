# Provider risk management as a product

A white paper for technical readers.

- Owner: henry.tran@uniblock.dev
- Written: 2026-08-17
- Specification: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Companion: [`../design-docs/technical-blueprint.md`](../design-docs/technical-blueprint.md)
- Language: ASD-STE100 Simplified Technical English. The terms in *italics* are defined in
  [`../../CONTEXT.md`](../../CONTEXT.md).

This paper is not the authority for any fact. Each fact has one home in this repository.
This paper gives a link to that home. If this paper and the linked document disagree, the
linked document is correct. This paper is then a defect.

## 1. The problem

A customer runs production traffic against hosted AI model *providers*. The customer treats
each provider as a reliable counterparty. This is not correct. A provider can do four things
without a warning:

- The provider can rate-limit the customer. Requests then return status 429.
- The provider can degrade. The provider stays available and becomes slow. No request fails.
- The provider can withdraw a model. The customer's prompts are written for that model.
- The provider can bill the customer for idle capacity. The customer holds a *reservation*.
  The customer's traffic does not address it.

Every AI gateway on the market answers these four problems in the same way. Each gateway
gives the customer a routing rule. The customer then writes the rule.

This answer has one defect. A routing rule holds what the customer believed on one day.
Provider behavior changes. The rule does not change. The customer must see the change and
write a new rule.

## 2. The market

We surveyed nine gateways against their published documentation on 2026-08-15. The
per-vendor facts and their sources are in
[the competitive landscape reference](../references/2026-08-15-ai-gateway-competitive-landscape.md).
Three results are important.

**Failover is a standard feature.** Routing by latency or cost is also a standard feature.
Almost every gateway has both. Neither is a product. Each is a function that the customer
configures.

**Every published price is always-on.** Examples are a percentage of money received, a flat
subscription for a volume of requests, and a price for each token. No surveyed vendor
charges only for a failover. Two limits apply to this result. No vendor has proved the
opposite model. Two vendors publish no rate card, so we cannot exclude a private term.

**Resilience and optimization do not work together at the largest vendor.** OpenRouter stops
its uptime-aware load balance when the customer sets `sort` or `order`. A customer who asks
for a low cost then loses the availability function. Nothing tells the customer about this
result.

Four things are unclaimed in the market:

- A gateway that stays out of the request path.
- Routing to a stated outcome.
- A price for an idle *reservation*.
- The sale of cross-customer evidence about *provider strain*.

## 3. The claim

A customer states an outcome for one class of traffic. The gateway then holds that outcome.
Or the gateway reports why it cannot hold it. The customer can examine the report.

The unit is the *workload*. It is not the customer and not the model. An interactive
workload and a batch workload need opposite results. One target for a whole customer cannot
serve both.

A *target* has five parts:

- Ceilings or floors on the *dimensions*. The vocabulary of dimensions is closed. It holds
  `p95_ms`, `cost_per_1k_tokens_usd` and `success_rate`.
- One *objective*. This is the dimension to minimize.
- A priority order. This order shows which ceiling yields first.
- Not more than one *hard dimension*. The gateway fails the request instead of a breach.
- *Allowed models*. This list is necessary and must not be empty. It is the customer's blast
  radius.

One rule keeps the vocabulary closed. A dimension must be a property of a provider that the
customer can verify. A dimension must not be a property of the customer base. This rule
excludes rate-limit headroom, because headroom is a property of a *cohort* at one moment.
Headroom has no *capability floor*, so the feasibility check must *abstain* for it always.

Model quality is excluded for a different reason. A score for model quality makes this
product a benchmark service. *Allowed models* gives the customer the necessary control
without a score.

Two results are more important than the vocabulary.

**Infeasibility is two states.** It is never one state. See
[ADR 0001](../adr/0001-declaration-time-vs-observed-infeasibility.md).

- *Infeasible by declaration* means that no allowed provider can satisfy the target. The
  gateway knows this before traffic flows. The gateway rejects the write of the
  *target document*. The customer cannot deploy an impossible target.
- *Unmet* means that no group of allowed providers has held the target. This is a runtime
  state. The gateway enters it after two missed *windows*. The gateway leaves it after two
  held windows.

The two states have different truth conditions and different meanings. The gateway must not
combine them.

**A decision must give its reason.** Each report is a diagnosis and not an alarm. Each report
must name the dimension at fault, the target value and the *binding reason*. A rejection must
also name the best achievable value, the provider that achieves it, and the *provenance* of
the capability floor. A number alone is not disputable. A dispute is the customer's only
recourse against a wrong floor.

The same rule applies to routing. The routing function returns a decision and not a provider.
The decision holds a reason for each rejected candidate. The gateway must not build the
reason from logs later.

## 4. The central choice

The gateway is a control plane in normal operation. The *connector* calls the provider. The
customer installs the connector at the call site. The connector uses the customer's own
provider credential. That credential never reaches the gateway.

The gateway does five things:

- It holds the *target document* and the reservation document.
- It checks the feasibility of a target at the time of the write.
- It measures a *window* for each workload and provider.
- It operates the *unmet* state machine.
- It sends a *ranked list* in a *directive*.

The connector holds one local routing rule. On a network error, a status 429 or a status
5xx, the connector tries the next provider in the *ranked list*. All policy stays in the
gateway. See [ADR 0006](../adr/0006-routing-authority-stays-gateway-side.md). Therefore one
implementation of the routing decision exists. The gateway makes the ranked list with
repeated calls to the same routing function. A second implementation cannot occur.

This choice gives two results.

**A gateway failure cannot stop customer traffic.** The connector continues with its last
*ranked list*. The gateway is therefore not a worse single point of failure than the
providers. This is the *fail-open* property. The cost is exact. A change to a target needs
approximately 5 seconds. A status 200 for a write means committed. It does not mean in force
in each process.

This result also changes the subject of a credit. The customer cannot see a control-plane
failure, because the traffic continues to the last provider. Therefore the gateway measures
its own *control-plane availability*. The gateway then issues the credit without a request
from the customer. A credit that only the vendor can detect is a written commitment or
nothing.

**The reports from the connector are the only input to the windows.** This is the weak part
of the choice. It failed one time and nobody saw the failure. The gateway kept the usage
reports for a price calculation. The gateway did not put them into the windows. Each provider
then stayed at *insufficient data* and *unmet* became unreachable. Each unit test passed. An
end-to-end check found the defect. The record is in the
[connector ExecPlan](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md).
Read its *Surprises & Discoveries* section first.

## 5. What the central choice prevents

The choice has four costs. Each cost is structural. A schedule cannot remove them.

**Budget control is not synchronous.** A synchronous refusal of a call must occur at the
moment of the call. Therefore the gateway sends a budget snapshot to the connector. The
connector then controls its own spend. The usage reports reconcile the spend later. The
gateway bounds the overspend. The gateway does not remove it. The bound is approximately
`report_interval` multiplied by `max_burn_rate`. See
[ADR 0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md). The market
can possibly refuse this bound. That question is open and is issue #21.

**Some customers cannot install a connector.** A team on a managed platform has no access to
its call site. A regulated customer needs a synchronous refusal of a call. These customers
are not unwilling. They are unable. The proposal is one mechanism for them. The gateway
operates a connector for the customer. See
[ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md). The out-of-path
property then applies to each workload and not to the whole product. This is a real loss.

**A routing change from cohort evidence is weaker evidence than an *interception window*.**
The gateway is in the request path during a window. The gateway then writes a header on each
intercepted response. That header goes into logs that the customer holds. The gateway cannot
do this in normal operation, because the gateway is not in the path. The strongest evidence
is therefore absent where the privacy question is most difficult. The customer gets the
*binding reason* on the status resource instead. The paper states this difference. It does
not hide it.

**A wrong *capability floor* looks like a slow provider.** No provider publishes a latency
floor. Therefore each floor comes from measurement and carries a *provenance* tier and an
age. See [ADR 0003](../adr/0003-provenance-tiered-capability-catalogue.md).

- A floor that is too optimistic costs the customer a wait until *unmet*.
- A floor that is too pessimistic costs the customer a capability. The customer gets no
  signal. A rejected target makes no traffic, so no evidence of our error can occur.

The gateway therefore rejects a target with caution. The target must fail the most optimistic
candidate floor by more than the variance of that floor. The check must *abstain* when each
source for a candidate is stale. The gateway then accepts the write. One weakness remains. A
floor for a new model is trusted and not verified, because only the new traffic can verify
it.

## 6. Privacy is a design constraint

The network effect of this product is also its largest disclosure surface. One customer's
traffic strains a provider. Another customer's routing then moves before a status 429. Four
mechanisms bound the disclosure.

**A *strain contribution* is a condition of service.** See
[ADR 0007](../adr/0007-strain-contribution-is-a-condition-of-service.md). A contribution
holds only the status code and the latency of one request. It never holds content, token
counts, per-customer counts or an identity. The provider side already saw each of these
facts. Therefore the customer gives up nothing exclusive.

Two alternatives failed. An opt-in never makes a *cohort* of sufficient size, so the behavior
never starts. An opt-out permits a customer to use cohort evidence and contribute none. A
contribution is not a hold on the customer. It stops when the use stops.

**Detection and disclosure use two aggregates.** See
[ADR 0005](../adr/0005-strain-evidence-detection-internal.md). Detection reads the internal
aggregate at a fine granularity. A detector that reads a published surface declares minutes
late. Disclosure reads only the aggregate that the contract bounds. This makes one hazard: a
customer-facing surface can read the internal aggregate. A test of the outputs cannot find
this hazard. Therefore the control is structural. The connection between the two aggregates
must not exist. Such a connection fails the build.

**No surface gives a time series of *provider strain*.** A correlation attack needs a time
series. A time series needs an endpoint. The gateway discloses a cohort-derived value only as
part of one decision record. The gateway never serves it from a queryable resource.

**The thresholds are stated.** The gateway discloses no cohort-derived value below 20
contributors to a *cell*. The number is 20 and not 10, because each recipient is also a
contributor. Subtraction of the recipient's own contribution must leave 10 others. A
disclosed key is no finer than `(provider, model-family)`, because a small region can
identify its occupants. A customer gets not more than one disclosure for each cell in each
bucket. The gateway never discloses the size or the members of a *cohort*.

One result follows. Between 10 and 20 contributors the behavior operates. The customer then
learns that cohort evidence moved the routing. The customer does not learn a *band*. The
gateway states this difference to the customer.

## 7. Price

The promise to the customer is not a price for each failure. The promise is different. The
customer does not pay for our presence in the request path. The customer pays for the
provider risk that we absorb.

The [specification](../product-specs/provider-risk-management-gateway.md#pricing-model) is
`Accepted`. It gives one flat subscription. The tier follows *spend under management*. The
gateway computes that quantity from the token counts of the connector and the *rate card*.
The rate card changes only forward. The *capability floor* can *abstain* and can change
backwards. Therefore the two artifacts stay separate. The specification has no percentage of
spend, no markup for each request and no charge for each failure.

Three commitments keep this model consistent. Each commitment removes an incentive.

- **An *interception window* costs nothing more than the subscription.** See
  [ADR 0004](../adr/0004-incidents-included-not-surcharged.md). The gateway declares the
  window. A gateway that its own declarations pay cannot declare honestly. The margin is
  therefore worst in a month with a bad provider. We accept this.
- **One case connects detection and money, in the opposite direction.** *Provider strain* is
  present. The gateway does not send a *directive* that the connector acknowledges. That
  period counts against *control-plane availability* and makes a credit. The gateway
  therefore loses money when it fails to open a window. The gateway gains nothing when it
  opens one.
- **A bypass is free in both directions.** An involuntary bypass makes a credit. For a
  voluntary bypass the customer removes the connector and stops the payment. No mechanism
  makes this costly. Such a mechanism makes this product the always-on service that the
  non-goals prohibit. Retention depends only on the value of a live control plane.

A *reservation* follows the same logic. The customer holds it and declares it. The gateway
never buys, holds or resells provider capacity. Custody of a reservation makes a bypass
costly, and this inverts the promise.

### The rate structure is open, and two documents disagree

This repository holds two different price structures. The disagreement is real.

- The specification is `Accepted`. The tier follows *spend under management*. It excludes a
  percentage of spend.
- [`pricing-strategy.md`](../product-specs/pricing-strategy.md) is a `Draft`. It gives a
  price for each connector, a free allowance and a volume discount. It also gives an
  alternative percentage of spend at 2 to 3 percent.

This paper does not solve the disagreement. Two facts make it smaller:

- [ADR 0011](../adr/0011-billing-unit-is-the-managed-workload.md) is *proposed*. It decides
  the unit and not the rate. The unit is the managed *workload*. The word *connector* leaves
  the price language. A connector is a process. A customer with 12 replicas of one service
  operates 12 connectors. A price for each connector bills that customer 12 times for one
  integration. Our infrastructure decides that number, and the customer does not.
- The draft records in its own constraints that no cost or capacity data exists for this
  product. Each rate in the draft comes from a comparison with competitors.

The rate structure is therefore open. It is issue #22. No number in the draft comes from a
customer or from a measurement of our own cost.

## 8. The evidence and its limits

The evidence is a set of commands. The specification lists each command and its result in
[Delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence).
Run these two commands:

```bash
npm --prefix gateway run e2e
```

```bash
npm --prefix gateway run load
```

The first command makes seven end-to-end checks. Examples: no chat-completion request occurs
in the access log of the gateway; a change of a target reaches the connector in 5 seconds
with an acknowledgement; the sample application continues after the stop of the gateway;
*unmet* occurs from connector reports alone. The second command fails when a target does not
move the traffic. This is necessary. An artifact that cannot fail is not evidence. This
command found two real defects. The unit tests were green for both defects.

The evidence proves these items:

- The six criteria of behavior 1.
- The three criteria of the connector.
- The criterion of behavior 4 for a *reservation*.
- The *fail-open* criterion.

Behaviors 2, 3 and 5 are unclaimed. Each has a stated trigger and not a date.

The evidence does not prove these items. A reader must not infer them.

- **Each run uses simulated providers on one host.** No deployment and no cloud account
  exists. Each *capability floor* in the catalogue is a plausible number. One opt-in command
  reached a real provider one time. It is a smoke test. **No capability floor is measured.**
- **No artifact drives `success_rate` to a breach.** The artifacts use `p95_ms` and
  `cost_per_1k_tokens_usd`.
- **The connector sends a *strain contribution*. The gateway aggregates nothing and
  discloses nothing.** Therefore no criterion of behavior 3 is claimed.
- **No criterion of the price model is claimed.** The credit, the invoice and the window
  records need behavior 2.
- **The build runs and is green. It cannot be a necessary check on this repository.**
  Therefore a red build does not stop a merge.
- **One defect is open.** The usage reports of a second customer corrupt the status of the
  first customer. An end-to-end check shows this today. A repair must occur before
  multi-tenancy.

## 9. The decisions for the reader

Seven questions have no answer in the code. Each question has an argument in progress. The
links are in [the handoff index](index.md#decisions-still-open). The order below is the order
in which one answer changes the next.

1. **Is an asynchronous budget control sufficient for the market?** A negative answer makes
   the central choice wrong. Each other question then changes.
2. **Do we operate a connector for customers who cannot install one?** This answer decides
   whether those customers are possible at any price.
3. **Do we hold provider credentials to make the installation easier?** A store of customer
   credentials is a target. Its value does not depend on our size. This answer decides the
   class of our company.
4. **Which rate structure, and which rates?** See section 7.
5. **What is the cost and the capacity of the push model?** One socket for each connector is
   cheap. Nobody has measured "cheap" here. Each rate from our own cost waits for this
   measurement.
6. **Does this product ship alone, or become the routing layer of `Gateway-LLM`?** See
   [the comparison](gateway-llm-comparison.md). `Gateway-LLM` acquires each part of this
   product except the routing to a stated outcome.
7. **What is the sequence to production?** The sequence is multi-quarter. Its first phase is
   one design partner and costs almost nothing.

This paper gives one recommendation. Answer question 1 first. It is cheap to answer and
expensive to get wrong. It needs conversations with customers and not code.
