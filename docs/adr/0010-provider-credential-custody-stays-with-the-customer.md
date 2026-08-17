# The gateway takes no custody of provider credentials by default

Status: proposed (2026-08-17)

[#18](https://github.com/hoomji/henry-ai-router/issues/18) Phase 3 names the question and does
not answer it: do customers keep `PROVIDER_API_KEY` in their own application's environment
forever — the current model, more secure and more friction — or do we take on secrets custody
so they can paste a key into a dashboard? The question is filed under the customer-facing UI
because that is where the friction shows up, but it is not a UI decision. It decides what class
of company this is, what a breach costs, and which compliance regime applies.

The decision: **provider credentials stay with the customer.** The connector reads the
credential from the customer's own environment, uses it in a call the customer's own process
makes, and the credential never reaches the gateway — the property
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) already records and the reason no provider account
is involved in any check this repository runs. Onboarding friction is reduced by making the
credential *easier to supply where it already lives* — environment variables, the customer's
own secret manager, a documented injection path — not by moving it to us.

The one exception is the in-path mode of [ADR
0009](0009-in-path-mode-is-a-gateway-operated-connector.md), where the gateway makes the
provider call and therefore must hold something. That exception is scoped narrowly below and is
the only path by which a provider credential ever enters our infrastructure.

## Considered options

**Custody by default: the customer pastes a key into our dashboard.** Rejected. It is the
easiest onboarding and the worst trade this product could make. A vault of customers' provider
credentials is a target whose value is unrelated to our size, and it converts a breach of our
control plane — which today cannot stop a single customer request, by design — into a breach
that can spend every customer's provider budget. It also inverts the specification's own
retention argument: the product is supposed to be safe to leave, and a customer whose keys we
hold is not. And it undoes the fail-open boundary's cleanest property, that a gateway outage
touches nothing the customer needs, since a credential we cannot serve is a credential their
traffic cannot use.

**No custody, ever, including in-path mode.** Rejected as incoherent rather than as
undesirable. If the gateway is the endpoint making the upstream call, it holds a credential;
the only alternative is a per-request credential passthrough from the customer, which means the
credential crosses our process on every request instead of resting in it — more exposure, not
less, and with no place to scope or revoke it.

**No custody by default; scoped custody only for in-path workloads.** Chosen. The default
posture is unchanged and remains a differentiator we can state plainly: we cannot spend your
provider budget because we cannot reach your provider. In-path mode is sold as the named
exception, alongside the path exception 0009 already names, so a customer choosing it is
choosing both trades at once and knowingly.

## Consequences

**Onboarding friction stays, and the fix has to come from documentation and tooling rather
than from architecture.** A customer must place a credential in their own environment before
the connector works. The onboarding UI prototype's three variants
([`docs/prototypes/onboarding-ui/`](../prototypes/onboarding-ui/README.md)) all assume this
shape; whichever wins, its job is to make the customer's own environment the easy path, not to
offer a text field that stores a key with us.

**The two required fallback variables are part of this posture, not an inconvenience.**
`CONNECTOR_FALLBACK_BASE_URL` and `CONNECTOR_FALLBACK_MODEL` are required rather than optional
so the connector works before the gateway is ever reachable. Anything that made the gateway the
source of a credential would make it a startup dependency of the customer's application, which
is the single property the out-of-path bet exists to avoid.

**In-path custody carries obligations this repository has none of today.** Encryption at rest
with a key we can rotate; per-credential scoping so one workload's credential cannot serve
another's; revocation the customer can perform without contacting us; an audit record of every
use; and a breach-notification path. None of it exists, and none of it should be built
speculatively. It is a precondition on in-path mode, and it is the largest single cost in that
mode's implementation — larger than the proxying itself.

**It changes which compliance conversations are possible.** A product that holds no provider
credential can answer a security review with an architectural fact instead of a control
narrative. That is a real commercial asset for the default mode, and it is exactly what an
in-path workload spends.

## Residual assumption

This assumes credential friction is not the thing that kills adoption. It might be: a
prospective customer who abandons onboarding at "put this in your environment" leaves no
record, and we would read the loss as disinterest rather than as friction. Phase 0 of
[#18](https://github.com/hoomji/henry-ai-router/issues/18) is where that is observable, and the
observation to make is not whether the design partner completes onboarding but how long they
take and where they stall.

It also assumes customers experience "we never hold your keys" as a benefit rather than as work
pushed onto them. Teams with a mature secret manager will read it as a feature. Teams without
one will read it as our problem that we made theirs, and for them the friction argument for
custody is at its strongest — which is the segment to watch if this ADR is ever revisited.
