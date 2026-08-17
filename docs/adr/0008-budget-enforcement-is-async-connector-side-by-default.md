# Budget enforcement is async and connector-side by default; synchronous denial is a separate, opt-in tier

Status: proposed (2026-08-17)

Productionizing toward billing ([#18](https://github.com/hoomji/henry-ai-router/issues/18),
Phase 4) forces a question the routing decisions left implicit. ADR
[0006](0006-routing-authority-stays-gateway-side.md) settled that the gateway computes
policy and pushes a ranked list, and the connector obeys it out of path — "the gateway is
not in the request path" is the architecture's central bet
([AGENTS.md](../../AGENTS.md), [ARCHITECTURE.md](../../ARCHITECTURE.md)), and productionization
"should survive productionization, not get compromised away for onboarding convenience"
([#18](https://github.com/hoomji/henry-ai-router/issues/18)). Budget enforcement is the
first behavior for which that bet does not obviously hold: a synchronous "deny this call,
it would exceed budget" decision requires evaluating the decision at the moment of the
call — i.e., being in the path — which is exactly what 0006 already rejected for routing.

The decision: budget is enforced the same way targets are — the gateway pushes a budget
snapshot to the connector, the connector self-enforces locally, and usage reports
reconcile actual spend back asynchronously over the existing report channel. This is the
default, and it is the only form of budget enforcement the core product guarantee covers.
A customer who needs synchronous, zero-overrun denial gets it through a separate,
explicitly scoped tier that does put a gate in the gateway's data path for their traffic —
sold as a named exception to the out-of-path guarantee, not folded into it silently.

## Considered options

**Connector self-enforces from a pushed snapshot, reconciled asynchronously.** Chosen.
Reuses the push-and-reconcile pattern 0006 already established for ranked lists and
reservations — no new component in the path, no second enforcement code path to keep in
sync with routing. Bounds overspend to a computable window rather than eliminating it:
`max overspend ≈ report_interval × max_burn_rate`, the same shape of cost as the five-second
target-propagation bound already accepted for routing.

**Synchronous budget gate in the gateway's data path for every request.** Rejected. Puts
the gateway back in the latency path of all traffic to enforce one property for the subset
of customers who need hard denial — the same trade 0006 rejected for per-request routing,
for the same reason: it removes the gateway's ability to be safely absent while adding
latency it was never meant to carry.

**Hybrid: async soft-budget as the default guarantee, sync hard-budget as a named opt-in
tier.** Chosen alongside the first option, not instead of it. Keeps the core guarantee
scoped and honest — routing and budget both stay out of path by default — while not
pretending the product can serve every customer's enforcement requirement without an
explicit, in-path exception for the ones who need it. The exception is a customer-visible
trade-off, not an implementation detail buried in how billing happens to work.

## Consequences

The core "gateway is never in the request path" claim narrows to: routing decisions never
touch the request path; budget enforcement is eventually consistent, bounded by
`report_interval × max_burn_rate`, within the same class of staleness the target-push
model already accepts. Marketing and sales language should state the bound, not an
unconditional guarantee — this is the same discipline 0006 applied by naming the
five-second bound rather than claiming instant propagation.

Billing/multi-tenancy work under [#18](https://github.com/hoomji/henry-ai-router/issues/18)
Phase 4 is not one feature but two: soft-budget (fits the existing push/reconcile
architecture directly) and hard-budget (does not, and needs its own path-entry design —
scope, auth, and latency budget for the in-path gate — before it is built, not assumed as
a variant of the first).

## Residual assumption

A compromised or buggy connector can overspend up to the bound above before the next
reconciliation catches it. This is a materially larger exposure window than a
synchronously-enforced proxy would have — the concrete failure mode uniblock-llm-gateway's
`HANDOFF.md` already documents in a system that *is* in-path (`/user/new` minting an
unbudgeted key). Accepting this bound is only sound as long as it is a stated number a
customer can evaluate against their own risk tolerance, not an unstated property. If a
customer segment requiring hard budget turns out to be most of the addressable market,
that undermines the premise that soft-budget-by-default is the right default, and this ADR
would need to be revisited rather than incrementally patched.
