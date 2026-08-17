# Pricing strategy

- State: `Draft`
- Owner: henry.tran@uniblock.dev
- Reviewed: 2026-08-17
- Sources: Chat discussion comparing this router's out-of-path gateway architecture against
  published pricing for OpenRouter, Martian, Requesty, Not Diamond, Portkey, Helicone,
  TrueFoundry, Kong AI Gateway, and Cloudflare AI Gateway (2026-08-17 market research).
- Supersedes: none

## User and problem

A customer evaluating this router needs to know what it will cost them before they adopt
it, and the business needs a pricing structure that recovers cost and produces revenue
without misrepresenting what they are paying for. Nothing in this repository currently
defines how the product would be priced, so every adoption conversation would have to
invent an answer on the spot, and any answer invented ad hoc risks contradicting the
architecture: this gateway is not in the request path and does not proxy tokens, so a
pricing model borrowed uncritically from proxy-based competitors would charge for a cost
this product does not incur.

## Outcome

A documented pricing structure that a customer-facing conversation, a pricing page, or a
billing implementation can be built from, with the reasoning for each choice traceable to
either this product's real cost driver (connector count, not token volume or request
volume) or a specific competitor comparison.

## Required behavior

1. The primary pricing model must be priced by connector/workload count, not by routed
   token spend or human seats, because connector count is this architecture's actual
   infrastructure cost driver (see [ARCHITECTURE.md](../../ARCHITECTURE.md)'s undocumented
   infra-sizing note) — unlike proxy-based competitors, whose request/token volume drives
   their compute cost.
2. A fixed number of connectors must be usable at no charge, sized for a pilot or
   single-service integration, so a prospective customer can validate the product before
   paying.
3. Above the free allowance, price per connector must fall as connector count grows
   (volume discount), so a large customer's marginal cost per connector decreases rather
   than scaling linearly against them.
4. An optional usage-aligned billing path (a percentage of routed spend) must be offered
   alongside the connector-based default, priced below the 5–5.5% norm set by OpenRouter,
   Martian, and Requesty, for customers who prefer that billing shape over a flat fee.
5. Marketing and sales language must describe the product's value as reliability and
   architectural guarantees (never in the request path, no added latency, no
   single-point-of-failure), not as a savings-on-tokens story, because the pricing model
   does not depend on token spend and should not imply that it does.

## Boundaries and failure behavior

- A customer who exceeds the free connector allowance without upgrading must be handled
  deliberately (e.g., a grace period or a hard block), not silently metered — this decision
  is unresolved, see Open product decisions.
- A customer on the usage-aligned (%-of-spend) path who also exceeds a connector-count
  threshold typically associated with the flat model must not be double-charged under both
  models simultaneously.
- Enterprise customers requiring custom terms (SSO, VPC, on-prem, custom SLA) fall outside
  both standard tiers and require a negotiated rate, consistent with how every competitor
  surveyed handles this segment.

## Non-goals

- This specification does not set final dollar figures — the rates below are a starting
  hypothesis for validation against real customer conversations, not committed pricing.
- This specification does not define billing implementation (metering, invoicing,
  payment processing).
- This specification does not address discounting policy, contract terms, or sales
  motion beyond the pricing shape itself.

## Constraints

- No infra cost or capacity sizing exists yet for this product (see
  [ARCHITECTURE.md](../../ARCHITECTURE.md)), so any per-connector rate below is derived
  from competitor comparison, not from this product's own measured cost. It must be
  revisited once real infra sizing exists.
- The connector-based model assumes "connector" means an active workload/service
  integration, not a human seat; this must stay consistent with how "connector" is used
  in [ARCHITECTURE.md](../../ARCHITECTURE.md) and the connector ExecPlan.

## Acceptance criteria

- [ ] A published rate card exists offering a free connector tier (Required behavior 2)
      and a per-connector rate that decreases at higher connector-count bands (Required
      behavior 3).
- [ ] A published or quotable percentage-of-spend rate exists as an alternative to the
      connector-based rate, and that rate is below 5% (Required behavior 4).
- [ ] Product marketing/positioning copy for this pricing does not lead with "cheaper
      tokens" or "spend savings" framing (Required behavior 5).
- [ ] The rate card does not charge both a per-connector fee and a percentage-of-spend
      fee to the same customer for the same connectors at the same time (Boundaries).

## Open product decisions

| Question | Blocking | Owner | Resolution |
|---|---|---|---|
| Final free-tier connector count (proposed: 5) | Yes | henry.tran@uniblock.dev | Open |
| Final per-connector rate and volume-discount bands (proposed: $15–25/connector/mo, discounted past 50) | Yes | henry.tran@uniblock.dev | Open |
| Final percentage-of-spend alternative rate (proposed: 2–3%, capped or tiered down above $50k/mo routed spend) | Yes | henry.tran@uniblock.dev | Open |
| What happens when a free-tier customer exceeds the connector allowance (grace period vs. hard block) | Yes | henry.tran@uniblock.dev | Open |
| Whether "connector" for billing purposes should be defined identically to "connector" in the architecture, or as a distinct billing unit | No | henry.tran@uniblock.dev | Open |

## Delivery evidence

Not yet delivered — no rate card, billing implementation, or published pricing exists.
