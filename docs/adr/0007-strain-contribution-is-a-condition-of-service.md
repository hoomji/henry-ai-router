# Strain contribution is a condition of service

Status: accepted (2026-08-15)

Behavior 3 routes on *provider strain* aggregated across the customer base. Resolving its
product shape ([#10](https://github.com/hoomji/henry-ai-router/issues/10)) required deciding
whether a customer may decline to contribute to that aggregate.

Contribution is a **condition of service**: not an opt-in, not an opt-out, and not a
per-customer setting. It is bounded in the same decision — a *strain contribution* carries
only facts the provider side of the connection already observed, being the status code and
latency of the customer's own request, and never request or response content, token volumes,
per-customer counts, or customer identity. The bound is not a softening of the mandate; it is
what makes the mandate defensible, and the two ship together or not at all.

The Constraints section already forbade an architecture of per-tenant data silos. That
prohibition turned out to be about the wrong thing: a per-customer opt-out flag satisfies its
letter completely while defeating what it protects, one tenant at a time.

## Considered options

**Opt-in.** The safest posture commercially and the easiest to sell. Rejected because it
never starts: the behavior needs roughly ten concurrently connected contributors per cell
before corroboration is reachable at all, and twenty before a band may be disclosed. An
opt-in rate short of near-universal leaves every cell below threshold indefinitely, so the
behavior the network effect exists to deliver never runs and the constraint it sits under is
violated in practice while satisfied on paper.

**Opt-out.** The procurement-friendly middle. Rejected on two grounds. It admits
free-riding — a customer consumes cohort evidence and anticipatory protection while
contributing none, and the customers most able to negotiate an opt-out are the
highest-volume ones whose contributions matter most. And it is the silo the Constraints
section forbids, arrived at one tenant at a time rather than by architecture.

**Condition of service with a bounded contribution.** Chosen. Contribution is mandatory and
its contents are capped at provider-observed facts. The customer gives up nothing they hold
exclusively: every fact in a contribution was already seen by the provider they sent the
request to.

## Consequences

There is procurement friction and this decision accepts it rather than pricing it away. Some
buyers require a data-sharing opt-out as a matter of policy regardless of what is shared, and
those deals will be argued on the bounded-contribution guarantee or lost. The guarantee has
to be stated in customer-facing terms, not only in this repository, or the argument cannot be
had.

A reader will collide this with the constraint forbidding any mechanism that makes leaving
costly. It is not one. Contribution is a condition of *use*: it stops when use stops, and
nothing contributed is data a departing customer loses or cannot take with them. The
specification states the distinction explicitly under both constraints, because a reader who
finds only one of them will reasonably conclude the two contradict.

Making every customer a contributor changes the arithmetic of the aggregation contract from
[#5](https://github.com/hoomji/henry-ai-router/issues/5). That contract sets a cohort minimum
of ten generally and twenty where the recipient of a value also contributed to the cell it
came from, so that self-subtraction still leaves ten others. Under condition of service every
recipient is a contributor to every cell they route through, so the differencing case is not
an exception — it is the only case, and twenty is the operative threshold for any
cohort-derived value shown to anyone.

Enforcement is deliberately absent from the routing path. A connector that reports nothing is
a stated degradation on the status resource, not a customer cut off from cohort evidence.
Withholding protection from a customer whose connector broke punishes them for a fault
usually ours, and it would turn a privacy mechanism into a commercial lever.

## Residual assumption

This assumes the bounded-contribution guarantee is auditable by a customer who does not trust
it. Today it is a claim in a specification: the contribution is assembled by a *connector* we
ship, and a customer who wants to verify that nothing else leaves their call site has only
our word and whatever they can observe on the wire. If that turns out to be the thing that
loses deals, the correction is to make the connector's outbound payload inspectable — not to
reopen the opt-out.
