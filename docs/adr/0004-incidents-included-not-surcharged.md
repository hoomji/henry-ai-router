# Incidents are included in the subscription, not surcharged

Status: accepted (2026-08-15)

The product specification originally required that the gateway "intercepts traffic — and
charges — only while a detected incident is in progress." Resolving the pricing model
([#7](https://github.com/hoomji/henry-ai-router/issues/7)) surfaced that this single
sentence welds two independent claims: that the gateway is absent from the request path
in normal operation (a data-path fact, established as credible by
[#4](https://github.com/hoomji/henry-ai-router/issues/4)) and that the customer is billed
only during incidents (a commercial fact, found to exist at none of the nine products
surveyed in [#3](https://github.com/hoomji/henry-ai-router/issues/3)). We keep the first
and drop the second: what a customer pays does not vary with whether an incident was
declared.

## Considered options

**Metered surcharge during declared incidents.** The literal reading of the original
requirement, and the one the product's own narrative implies — you pay when we work.
Rejected on a conflict of interest that is structural rather than a matter of discipline:
the gateway is the party that declares the incident window
([#9](https://github.com/hoomji/henry-ai-router/issues/9)), so under this option every
declaration is a billing event authored by its own beneficiary. Every argument for
making window edges auditable is an argument that we already expect this to be
questioned. The auditability requirement mitigates the appearance of the problem without
touching the incentive that creates it.

**Retrospective tiering on incident volume.** Incidents move a customer between tiers at
renewal rather than mid-term. Rejected as the same shape with a delay: the incentive is
smaller but points the same way, and it additionally makes every renewal a negotiation
about the accuracy of our own incident log — the one record the customer has no
independent means to check.

**Included in the subscription.** Chosen. A flat subscription tiered on spend under
management, with no line item that varies with incident activity. The gateway is paid for
standing ready, which is what a customer buying provider risk management is actually
buying, and it removes any financial reason to declare an incident that is not one — or,
equally, to under-declare in a month when margin is thin.

## Consequences

The cost accepted is real and falls on us: margin is worst in exactly the month a
provider degrades badly, because incident-time work is priced *into* the tier rather than
recovered from it. Incident cost therefore has to be estimated in advance and carried,
which makes tier boundaries a forecasting problem rather than a pass-through. This is why
the specification now requires metering to run for every connected customer from day one,
billed or not: the distribution that sets those boundaries cannot be reconstructed later.

It also removes the gateway's only conditional revenue lever, which means the pricing
model has no mechanism that rewards a customer for staying. Combined with the absence of
custody over reservations, bypass is free in both directions by construction — a customer
who removes the client owes nothing and forfeits nothing. That is accepted deliberately:
any mechanism that made leaving costly would recreate the always-on middleman the
specification's non-goals exclude, and it is better to learn from churn that the control
plane is not worth paying for than to prevent that signal from arriving.

One position this decision is worth stating plainly against the surveyed field: every
competitor's pricing charges more when things go wrong, whether by percentage of spend, by
request volume, or by log volume. This one does not. That is the sharpest available
expression of the difference between selling routing and selling risk absorption, and it
is only defensible because we gave up the surcharge that would have contradicted it.

## Residual assumption

This decision assumes incident cost is estimable in advance well enough to price. We have
no incident history, so the first tier boundaries rest on a forecast with no data behind
it. If provider incidents turn out to be heavy-tailed in cost rather than in frequency,
the flat tier absorbs a loss we cannot re-price until renewal, and the correction
available to us is slow by design.
