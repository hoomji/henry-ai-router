# In-path mode is a gateway-operated connector, not a second product

Status: proposed (2026-08-17)

Two open questions turned out to be the same question, and answering them separately would
have produced two mechanisms for one need.
[#20](https://github.com/hoomji/henry-ai-router/issues/20) asks whether to serve customers who
cannot or will not install a connector — no control over their call site, a compliance
requirement, or a preference for one endpoint over an SDK — by having the gateway proxy their
requests the way `unified-request` does. ADR
[0008](0008-budget-enforcement-is-async-connector-side-by-default.md) carves out a
"synchronous, zero-overrun denial" tier that "does put a gate in the gateway's data path for
their traffic," and #21 asks whether that tier is the same thing #20 is scoping. It is.

The decision: **there is one in-path mechanism, and it is a connector the gateway operates on
the customer's behalf.** A customer in in-path mode points their base URL at the gateway; the
gateway runs the same connector logic inside its own process, against the same *ranked list*
the same control plane computes, and reports usage through the same ingestion path. Nothing
about *policy* changes — the target document, the feasibility check, the measurement windows,
the `unmet` state machine and `computeRankedList` are untouched and unaware of which mode a
workload runs in. What changes is who hosts the connector and who holds the provider
credential ([ADR 0010](0010-provider-credential-custody-stays-with-the-customer.md)).

Hard budget is then not a third thing. It is a property that in-path mode makes available,
because a gateway that is already in the path can refuse a call before it is made. Soft budget
remains the default and the only form the core guarantee covers, exactly as 0008 says.

## Considered options

**Out-of-path only; decline the segment.** The purest reading of the architecture. Rejected,
but not easily — it has the strongest claim on the product's identity. The reason it loses is
that the segment it declines is not defined by unwillingness but by inability: a team on a
managed platform with no access to its own call site, or a regulated buyer who needs
zero-overrun spend control, cannot become a customer at any price. Declining them is a
decision to be a smaller product, which is legitimate, but it should be made knowingly rather
than inherited from an architecture diagram. Nothing here forecloses it: in-path mode ships
behind a named exception and can be withdrawn.

**A separate in-path product with its own routing implementation.** Rejected on the same
grounds ADR [0006](0006-routing-authority-stays-gateway-side.md) rejected connector-side target
evaluation: two implementations of the routing decision that must not drift, in a repository
whose entire structure exists to keep that decision pure and singular. It also quietly makes
"risk management, not plumbing" into two theses, one of which is plumbing.

**A synchronous gate in the data path for all traffic.** Rejected, already, by 0008. Restated
here because it is the option a reader will reach for when they see "in-path": it puts the
gateway in the latency path of every request to serve a property a minority needs.

**One control plane, two connector hosts.** Chosen. The connector's contract is already a
network contract — it receives a ranked list, calls providers, reports usage — so a
gateway-hosted instance of it is a deployment topology rather than a second design. The
customer-visible difference is stated as a trade, not smoothed over: in-path mode adds our
latency and our availability to their request path, and in exchange gives them ground-truth
telemetry, hard budget, and no install.

## Consequences

**The out-of-path guarantee narrows to a per-workload property and must be stated that way.**
"The gateway is never in your request path" stops being true of the product and becomes true
of a mode. Every sentence that makes the unconditional claim — in
[`README.md`](../../README.md), the spec's Outcome, and any sales copy — needs the qualifier.
ADR 0008 already applied this discipline to budget propagation; this extends it to the path
itself.

**In-path mode reintroduces every property out-of-path was built to avoid, for that
workload.** The gateway becomes a single point of failure for that customer's traffic; the
fail-open boundary is unavailable, because there is nothing to fail open *to* when we are the
endpoint; our latency is added to theirs; and the availability credit stops being a
control-plane credit and starts looking like a request-path SLA, which the pricing model
deliberately never offered. Pricing an in-path workload identically to an out-of-path one
would mean selling a materially different risk for the same money.

**It also fixes the one telemetry weakness the architecture has.** Connector-reported usage
being the only input to the measurement windows is the property that broke invisibly once. An
in-path workload produces ground truth, which makes it the natural place to validate that
out-of-path reporting is honest — a use for the mode beyond the segment it was built for.

**The structural rule that keeps this honest is testable.** In-path mode must consume
`computeRankedList` and the usage-ingestion path rather than reimplementing either. A second
routing comparator or a second usage path appearing under an in-path module is the failure
this ADR exists to prevent, and it is checkable the same way the existing dependency rule is:
by naming which modules may import which.

## Residual assumption

This assumes the connector's logic is genuinely hostable by us — that nothing in it depends on
running inside the customer's process. Two things might: the statically configured fallback
provider, which exists so the connector is safe to install before the gateway is reachable and
is meaningless when the gateway *is* the endpoint; and the customer's provider credential,
which today never reaches the gateway at all. The second is the real dependency and it is why
[ADR 0010](0010-provider-credential-custody-stays-with-the-customer.md) has to be resolved
before this one can be implemented rather than alongside it.

It also assumes the segment is real. Nobody has yet said "I cannot install your connector" —
the segment is inferred from `unified-request` existing and from how compliance-constrained
buyers behave, not observed. Phase 0 of
[#18](https://github.com/hoomji/henry-ai-router/issues/18) is where that gets tested, and if
one design partner installs the connector without complaint, the priority of this whole ADR
drops.
