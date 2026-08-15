# Routing authority stays gateway-side; the connector obeys a ranked list

Status: accepted (2026-08-15)

Resolving the behavior sequence ([#8](https://github.com/hoomji/henry-ai-router/issues/8))
forced a question the earlier resolutions left implicit. Pricing ([#7](https://github.com/hoomji/henry-ai-router/issues/7))
recorded that "the client fails over locally during normal operation," and detection
([#9](https://github.com/hoomji/henry-ai-router/issues/9)) made out-of-path the permanent
architecture rather than an incident-conditional state. Taken together those say a
customer-installed component decides where traffic goes for most of the product's life —
which raises the question of how much of the routing decision lives there.

The decision: the *gateway* computes routing and pushes a *ranked list* per *workload*; the
*connector* obeys it and carries exactly one local rule, which is to try the next provider
in the list when a request errors. The connector never evaluates a *target*, never sees the
target document, and holds no policy.

## Considered options

**The connector evaluates targets locally.** The customer's target document, or a compiled
form of it, is pushed to the connector, which measures providers and picks per request. This
is the literal reading of "fails over locally" and has one genuine advantage: routing
survives a control-plane partition with full fidelity rather than degrading to a stale list.
Rejected on three counts. It requires two implementations of `chooseProvider` that must not
drift, in a repository whose whole ExecPlan structure exists to keep that function pure and
singular. It makes the *binding reason* unauthoritative — the connector cannot cite the
cross-customer state (*provider strain*, capability floors, cohort evidence) that the
specification requires a reason to name, so the gateway would be publishing reasons for
decisions it did not make. And it inflates the install: the specification's stated retention
argument is that the product is worth paying for because the connector alone is weak, and a
connector that carries the whole policy weakens that argument by making it strong.

**The gateway decides per request, out of path, synchronously.** The connector asks before
each call. Rejected immediately: it puts the gateway back in the latency path of every
request while removing its ability to actually serve one, which is the worst of both
architectures.

**The gateway decides, the connector obeys a ranked list.** Chosen. One policy
implementation, one authoritative binding reason, a connector small enough to be a credible
install, and a degradation story the specification already commits to — without a live
control plane the connector falls back to a static base URL, "no mix, no feasibility check,
no strain signal, no interception," which is only coherent if the mix was pushed rather than
computed locally.

## Consequences

Routing fidelity is bounded by push latency. A ranked list is a decision made against a
snapshot that is already slightly old when it arrives, so target-state routing out of path
is coarser than the per-request selection the tracer milestones implement in path. The
specification's five-second bound on a target change taking effect is the shape of that cost,
and it is why *provider strain* pushes a *directive* rather than waiting for the connector to
notice.

The local failover rule is deliberately dumb and deliberately insufficient. It handles the
common case — this provider just errored, try the next — and it cannot handle the case
*interception* exists for, which is deciding per request with knowledge and credentials the
connector does not have. That insufficiency is what keeps behavior 2 a real behavior rather
than something the connector quietly absorbs.

This decision also fixes which component writes which response header. The *connector* is the
only component in the path during normal operation, so it writes the target-state header; the
*gateway* is in the path during an *interception window*, so it writes the interception
header. Both land in logs the customer holds, which is the property ADR
[0005](0005-strain-evidence-detection-internal.md) relied on — that property was never about
which of our components authored the record, only about who keeps it.

## Residual assumption

This assumes a ranked list is expressive enough to hold a target that a per-request decision
would hold. A target whose satisfying mix is a *ratio* between providers rather than an
ordering — hold p95 by sending some fraction to the fast expensive one — is not expressible
as an ordering, and would need the list to carry weights. Nothing has yet demonstrated that
such a target is common enough to matter, so the list stays an ordering until one does.
