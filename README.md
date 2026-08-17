# henry-ai-router

An exploration of **provider risk management** as an AI-gateway product: the customer states
what they need from their AI traffic — a latency ceiling, a cost ceiling, a success-rate
floor — and the system holds it for them by moving traffic between providers, without them
ever writing a routing rule.

Existing AI routers sell routing rules, a unified schema, and dashboards. The bet here is
that the product is the *risk*, not the plumbing: providers rate-limit, degrade, deprecate
models, and go down, and today every customer discovers that alone, reacts after the
failure, and pays an always-on middleman for the privilege.

**Status: a working prototype of two of five behaviors, and every check outside one opt-in
command still runs against simulated providers on localhost.** Nothing is deployed. That one
exception — `npm --prefix gateway run real-provider-check` — is credential-gated, never run
by CI, and has reached a real provider (OpenRouter) and gotten a real response; see [the
learning ledger](docs/harness/learning-ledger.md). It is a smoke test, not a measured
capability floor: no capability floor has been measured. See [Delivery
evidence](docs/product-specs/provider-risk-management-gateway.md#delivery-evidence) for what
is proven and, more usefully, what that proof does not establish.

## The surprising part

**In normal operation the gateway is not in the request path.** The customer's application
calls the provider *directly*, through a connector installed at their own call site. The
gateway is a control plane: it holds the target, measures how each provider is doing from
usage the connector reports back, and pushes ordered lists of providers over Server-Sent
Events. It never carries the traffic.

Two consequences do most of the work. A gateway outage cannot stop customer traffic — the
connector keeps calling whichever provider it was last told to prefer, so the trade is that
a target change takes about five seconds rather than being instant. And because the gateway
is out of the path, connector-reported usage is the *only* input its measurement windows
have — a fact that is easy to break invisibly, and did break invisibly once
([the story](docs/exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md)).

- **`gateway/`** — the control plane. Target and reservation documents with optimistic
  concurrency, declaration-time feasibility checking against capability floors, rolling
  measurement windows, the `unmet` state machine, and ranked-list push.
- **`connector/`** — the component that installs into the customer's application and makes
  the provider call. It obeys the ranked list, fails over on a 429 or 5xx, relays streams
  without buffering, and reports usage back.

Both are TypeScript on Node 24 with **zero runtime dependencies** outside the standard
library.

## Try it

```bash
python scripts/setup.py && npm --prefix gateway install && npm --prefix connector install
```

Then the one command that demonstrates the central claim — it starts the stub providers, the
gateway and a sample application itself, and drives seven checks:

```bash
npm --prefix gateway run e2e
```

Among them: no chat-completion request appears in the gateway's access log at all, a target
switch reaches the connector within five seconds with its acknowledgement recorded, the
sample application keeps working after the gateway is killed, and a workload reaches `unmet`
on connector reports alone with zero in-path requests.

To watch a target actually move traffic — same providers, same load, two different targets:

```bash
npm --prefix gateway run load
```

It exits non-zero unless the split moves in the right direction, which is the point: an
artifact that cannot fail is not evidence. It has caught two real defects that the unit
suite, green throughout, could not see.

The full gate is `python scripts/check.py` (add `--e2e`). Substitute `py` for `python` if
that is what your machine has.

## Reading it

Most of this repository is documentation, and it is indexed rather than browsed.

**Reviewing this as a proposal?** [`docs/handoff/index.md`](docs/handoff/index.md) is a table
of contents over every document here, and
[`docs/handoff/reading-guide.md`](docs/handoff/reading-guide.md) walks them in order — 45
minutes for the core path. Start there rather than with the table below. If you would rather
have the argument in one document than walk nine, read
[`docs/handoff/white-paper.md`](docs/handoff/white-paper.md) instead — 15 minutes, and it is
explicit about what the evidence does not establish.

| Question | Where |
|---|---|
| What is this required to do for a user? | [`docs/product-specs/`](docs/product-specs/index.md) |
| Why is this a product, and what does the architecture cost? | [`docs/handoff/white-paper.md`](docs/handoff/white-paper.md) |
| What is the whole system meant to become? | [`docs/design-docs/technical-blueprint.md`](docs/design-docs/technical-blueprint.md) |
| How is it put together, and what must not be broken? | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Why was this decided this way? | [`docs/adr/`](docs/adr/) |
| What do these words mean here? | [`CONTEXT.md`](CONTEXT.md) |
| What was built, and what did it teach? | [`docs/exec-plans/`](docs/exec-plans/index.md) |
| How should an agent work in this repository? | [`AGENTS.md`](AGENTS.md) |

The repository is also a harness experiment: it is built to be worked on by coding agents,
with the commands, the evidence contract, and the capability state written down in
[`docs/harness/`](docs/harness/manifest.yaml). Every claim there is meant to be one a
command can settle — including
[`scripts/docs-audit.py`](scripts/docs-audit.py), which exists because documentation can
pass every check while being false.

## What is not here

Behaviors 2, 3 and 5 of the specification — strain-triggered interception, collective
fatigue-aware routing, and semantic-fidelity prompt translation — are specified and
deliberately unbuilt, with their triggers recorded. There is no deployment, no
multi-tenancy, no billing, and no measurement against a real provider: the capability floors
the feasibility check rejects targets against are plausible numbers, not measurements.
