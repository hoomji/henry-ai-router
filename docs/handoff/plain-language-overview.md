# Plain-language overview

- Owner: henry.tran@uniblock.dev
- Written: 2026-08-17
- Companion: [`white-paper.md`](white-paper.md), [`../design-docs/technical-blueprint.md`](../design-docs/technical-blueprint.md)
- Language: plain English, deliberately. The rest of the handoff set is written in
  ASD-STE100 Simplified Technical English, which reads flat. This document is the opposite:
  the pitch and the mechanism in ordinary prose, for a reader who wants the shape before
  the rigor.

This document is not the authority for any fact. Each fact has one home in this repository;
the [white paper](white-paper.md) links to those homes. If this document and an owning
document disagree, the owning document is correct.

## In one paragraph

**henry-ai-router** is a provider risk management gateway for teams running production
traffic against hosted AI models. Instead of asking you to hand-write routing rules that go
stale the moment provider behavior changes, you state the outcome you need — a latency
ceiling, a cost floor, a success rate — per workload, and the gateway either holds that
outcome or tells you exactly why it can't, with the dimension, value, and reason attached to
every decision. Its core benefit is that it stays **out of your request path**: a
lightweight connector inside your own application calls providers directly with your own
credentials, so a gateway failure can never stop your traffic and your API keys never leave
your environment. It's built for platform and infrastructure engineers who treat AI
providers as production dependencies, not hobbyists routing a side project. And the risk is
reversed at every layer: traffic fails open if the control plane dies, incidents cost
nothing beyond the flat subscription, control-plane downtime triggers credits you don't have
to request, and leaving is free — remove the connector and the payment stops, with no
credential custody or capacity lock-in holding you.

## In four minutes

**The problem.** Teams treat hosted AI providers as reliable counterparties, and they
aren't: a provider can rate-limit you, degrade while staying "available," withdraw the model
your prompts were written for, or bill you for reserved capacity your traffic never touches.
Every existing gateway answers this with a routing rule *you* write — a snapshot of one
day's beliefs that never updates itself. The
[market survey](../references/2026-08-15-ai-gateway-competitive-landscape.md) found four
unclaimed positions: staying out of the request path, routing to a stated outcome, pricing
idle reservations, and cross-customer strain evidence.

**How it works.** Two runtimes, no shared code, HTTP only. The **connector** installs at
your call site, reads your provider credential from your own environment, makes the actual
calls, and obeys a *ranked list* the gateway pushes (roughly 5 seconds from a change to new
routing, over SSE with a poll fallback). The **gateway** is a pure control plane: it holds
per-workload *target documents*, rejects infeasible targets at write time with a disputable
best-achievable value, measures 5-minute windows from connector reports, runs the *unmet*
state machine (two windows in, two out), and derives the ranked list from one pure routing
function so only one routing implementation can exist. During provider strain it may briefly
enter the path (an *interception window*) to move in-flight requests, stamping a header on
every intercepted response so the evidence lands in your own logs.

**What's real.** Outcome routing, the connector, and reservation-aware routing are built and
proven by end-to-end and load checks — including "the sample app keeps working after the
gateway is killed." Interception windows, collective signals, and prompt translation are
specified but unbuilt, each gated on a named condition, not a date. All evidence so far uses
simulated providers on one host; no capability floor is measured, and one multi-tenancy
defect is open. The
[delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence)
section states all of this plainly.

**The risk reversal, structurally.** Fail-open is the system's first invariant: your traffic
reaches providers even if the gateway is corrupt, unreachable, or mid-deploy. The gateway
never holds your provider credentials — custody was rejected as "the easiest installation
and the worst trade." Incidents are included, never surcharged, because a gateway paid per
incident can't declare them honestly. The gateway measures its *own* control-plane
availability and issues credits proactively, since fail-open means you can't see its
failures yourself. And bypass is free in both directions: remove the connector, stop paying.
