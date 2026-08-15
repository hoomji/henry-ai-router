# Ship the connector, then reservation-aware routing

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. Follow the repository's ExecPlan guidance at `PLAN.md` (repository root).

## Purpose / Big Picture

Today the gateway in this repository is the request path: a customer would point their
application at it, and it would forward each call to a provider it chose. The product this
repository specifies works the other way round. The gateway stays *out* of the request path
in normal operation, and a small component installed at the customer's own call site — the
**connector** — calls providers directly, obeying an ordered list of providers the gateway
pushes to it. The gateway only takes the request path during the exceptional periods
specified as behavior 2, which this plan does not build.

That component does not exist. Nothing in the repository builds it, and almost everything
the product specification promises depends on it: the token counts that compute what a
customer is billed, the acknowledgement that bounds an audit record, the telemetry that
shows a customer's pre-paid provider capacity going unused, and the delivery of target-state
routing itself.

After this plan, a person can start the gateway and a sample application wired to the
connector, watch the sample application's requests go **directly to a provider** with the
gateway never touching them, change a routing target through the gateway's management API,
and watch the connector switch providers within seconds because the gateway pushed it a new
ordered list. They can then declare a block of pre-paid provider capacity, send traffic that
ignores it, see the gateway report that the capacity is going unaddressed, and watch eligible
traffic move onto it.

Everything is demonstrable against stub providers on localhost. No provider credentials and
no cloud account are needed at any point in this plan.

## Progress

- [ ] M1 — the connector: direct provider calls, pushed ordered lists, acknowledgement,
      token reporting, streamed pass-through, and customer authentication.
- [ ] M2 — reservation-aware routing (product specification behavior 4): a declared
      reservation, unaddressed-capacity reporting, and routing preference onto it.

Add a timestamped entry at every stopping point. This checklist must state the actual state
of the work, not the originally intended sequence.

## Surprises & Discoveries

None yet.

## Decision Log

- Decision: The component built after the tracer is the connector, which is not one of the
  product specification's five behaviors. The second *behavior* is behavior 4
  (reservation-aware routing). Behavior 2 (strain-triggered interception) is third.
  Behavior 3 (collective fatigue-aware routing) is deferred until roughly ten customers are
  concurrently connected per provider/model/region cell, and behavior 5 (semantic-fidelity
  prompt translation) is deferred behind behavior 2.
  Rationale: Grilling ticket [#8](https://github.com/hoomji/henry-ai-router/issues/8).
  Behaviors 2, 3 and 4, the pricing model's usage meter, and behavior 1's own delivery all
  consume the connector, so building any of them first would smuggle it in as an
  unspecified side effect of something else. Behavior 4 follows because it needs nothing
  beyond the connector — no provider credentials, no cross-customer data, no cohort
  multi-tenancy — and extends machinery the tracer plan already builds. Behavior 3 is
  blocked by a commercial fact rather than a technical one: its anonymization contract
  suppresses every published cell below ten customers, so at current scale it would emit
  nothing. Behavior 5's moment is a cross-model failover mid-interception, which behavior 2
  creates. Recorded in the product specification's *Behavior sequence and deferrals*
  section.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: Routing policy stays entirely in the gateway. The connector receives an ordered
  list of providers per workload and holds exactly one rule of its own: when a request
  errors, try the next provider in the list.
  Rationale: The alternative — pushing targets to the connector and evaluating them there —
  requires two implementations of the routing decision that must not drift, and makes the
  *binding reason* the specification requires unauthoritative, because the connector cannot
  see the cross-customer state a reason has to cite. Recorded in ADR
  [`0006`](../../adr/0006-routing-authority-stays-gateway-side.md).
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: A declared reservation is its own resource, not a field in the target document.
  Rationale: A target states an outcome the customer wants; a reservation states a fact about
  their contract with a provider. Held in one versioned document, a reservation's term
  expiring would change what a target means with no customer write — and the target document
  is specified as holding only what the customer authored.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: The connector passes streamed responses through from M1. The provider adapter
  contract's chunk transform stays deferred.
  Rationale: The connector is in the streaming path from its first day, because real chat
  traffic streams and the connector is what calls the provider. But it only needs to relay
  bytes and count tokens at the end — it never transforms a stream. Transformation is needed
  only when the *gateway* is mid-stream, which happens during behavior 2's interception
  window and not before.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: Customer authentication and a real customer key land in M1. Cohort
  multi-tenancy does not.
  Rationale: A connector must identify itself to be pushed a list and to report token
  counts, and the specification requires metering to run for every connected customer from
  their first day — which a single hardcoded customer key cannot express. That is an
  identity change. The larger data-model change, cohort membership across customers, belongs
  to behavior 3 and stays deferred with it.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: The connector writes the `x-gateway-target-unmet` response header; the gateway
  will write behavior 2's interception header when that behavior is built.
  Rationale: In normal operation only the connector is in the path, so only it can write a
  response header at all. The property that made the header worth specifying — the record
  lands in logs the customer keeps and we cannot retroactively edit — is unaffected by which
  of our components authors it.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: The connector contributes strain evidence from M1, even though behavior 3 is
  deferred. A usage record gains the response status code, the model and provider region
  completing the cell key, and any rate-limit limit/reset headers; the strain buffer sheds
  load by sampling while the usage buffer keeps dropping oldest first.
  Rationale: Grilling ticket [#10](https://github.com/hoomji/henry-ai-router/issues/10).
  Contribution is a condition of service ([ADR
  0007](../../adr/0007-strain-contribution-is-a-condition-of-service.md)), and behavior 3's
  trigger counts customers *concurrently connected* per cell — a cohort cannot be built
  retroactively, so a behavior that starts collecting on the day it is built can never find
  its trigger already met. The buffering split is not symmetry for its own sake: drop-oldest
  is correct for a bill and wrong for a burst, because it discards the onset of the storm the
  cohort exists to detect and loses most from the customers hit hardest. Aggregation, banding
  and disclosure remain with behavior 3; this adds fields and a buffer, not a milestone.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

## Outcomes & Retrospective

Not started.

## Context and Orientation

### What exists before this plan starts

This repository (`henry-ai-router`) holds a product specification and, once its predecessor
plan is executed, a runnable gateway. That predecessor is
[`2026-08-14-provider-risk-gateway-tracer.md`](2026-08-14-provider-risk-gateway-tracer.md)
in this same directory; it is checked in and incorporated here by reference. **Do not start
this plan until that one is complete.** What it leaves behind, and what the steps below
assume:

- A `gateway/` directory at the repository root: a TypeScript project running on Node.js 24
  or newer, with zero runtime dependencies beyond the Node standard library, built with
  `tsc`, and started with npm scripts recorded in `AGENTS.md`.
- `gateway/src/server.ts`, an HTTP service exposing `POST /v1/chat/completions` that
  forwards a request to a provider and returns the response.
- `gateway/src/routing/chooseProvider.ts`, exporting
  `chooseProvider(request, state): RoutingDecision`. It is a pure function: it reads no
  clock, performs no network calls, and touches no global state. Everything it considers
  arrives in the `state` argument, and it returns both a chosen provider and a *binding
  reason* — which dimension bound the decision and why each other candidate was rejected.
- `gateway/src/providers/`, one adapter per provider, each a pure pair of translation
  functions with no HTTP-server types in it.
- `gateway/src/targets/store.ts`, a SQLite database in WAL mode reached through Node's
  built-in `node:sqlite`, holding the target document and runtime state.
- Management endpoints `GET`/`PUT /v1/targets` and `GET /v1/workloads/{name}/status`.
- `gateway/src/dev/stubUpstream.ts`, a tiny HTTP server returning a canned completion, so
  everything is testable with no provider credentials.

### Terms this plan uses

Defined here in plain language because this plan must be readable on its own. The
repository's canonical glossary is `CONTEXT.md` at the repository root.

A **gateway** is the service in `gateway/` that decides which provider should serve a
customer's traffic. A **provider** is a hosted third party that answers model requests
(OpenAI, Anthropic, Amazon Bedrock, Azure OpenAI); in this plan every provider is a stub
process on localhost.

A **connector** is the new component this plan builds: a small library the customer installs
in their own application, at the place where their code calls a provider. The connector makes
that call itself, straight to the provider. The gateway does not see the request.

A **workload** is a customer-named class of traffic — for example `chat` and `batch` — that
carries its own routing goals. Every customer has one named `default`.

A **target** is what a customer states they need from a workload: ceilings and floors over
three measurable quantities (95th-percentile latency in milliseconds, cost per thousand
tokens in US dollars, and success rate), rather than a rule saying which provider to use.
Targets live in a versioned **target document**, one per customer, which the customer edits
through the gateway's management API. The connector never sees a target.

A **ranked list** is the ordered sequence of providers the gateway computes from a target and
sends to the connector for one workload. It is the entirety of what the connector knows about
routing. A **directive** is the push that delivers a ranked list; the connector
**acknowledges** it, and that acknowledgement is what proves the connector actually adopted
it.

**Unmet** is the state of a workload whose target no provider mix has held over two
consecutive measurement windows. It is reported on a status resource and, from this plan
onward, as a response header the connector adds.

A **reservation** is provider capacity the customer has already paid for under their own
contract with that provider — Amazon Bedrock Provisioned Throughput, or Azure OpenAI
Provisioned Throughput Units. It is capacity that is charged whether or not it is used. The
gateway never buys, holds, or resells one. **Addressing a reservation** means sending a
request in the specific way that consumes that pre-paid capacity instead of falling through
to pay-as-you-go pricing. On Bedrock the common mistake is passing the foundation model's
identifier instead of the provisioned model's ARN, which silently routes the call to
on-demand capacity while the reservation sits idle and billed.

**Spend under management** is the customer's provider spend on traffic the gateway manages,
computed from token counts the connector reports against a published price schedule. It is
what the customer's subscription tier is indexed to. The gateway never takes a percentage of
it and never touches the money.

### Why the gateway is not in the request path

This is the single most surprising thing about the architecture and the reason this plan
exists. A customer's application talks to providers directly; the gateway influences it by
pushing ranked lists. Three consequences drive the work below.

First, when the gateway is unavailable, the customer's traffic is unaffected — it keeps going
to whichever provider was last pushed. The gateway is not a single point of failure, which is
the product's central boundary. It also means a gateway outage is invisible to the customer,
which is why the gateway is required to measure its own availability rather than wait to be
told.

Second, routing is coarser than it would be in the request path: a ranked list is a decision
made against a snapshot that is slightly stale by the time it arrives. The specification's
allowance that a target change takes effect within about five seconds is the shape of that
cost.

Third, anything that must happen per individual request — deciding mid-flight to send *this*
request to a different provider — is impossible for the connector, because it would need
credentials for every provider, which is an install burden this product refuses. That is what
behavior 2 exists for and why the in-path server built by the predecessor plan is kept rather
than discarded.

## Plan of Work

The work is two milestones. M1 builds the connector and the control-plane channel that feeds
it, which turns the gateway from a proxy into a control plane. M2 builds behavior 4 on top,
which is small precisely because M1 did the structural work.

## Milestones

### M1 — The connector: direct provider calls under pushed ranked lists

Goal: a customer's application calls providers directly through a library, while the gateway
— touching none of those requests — decides which provider it should be using and pushes
that decision, receives the token counts back, and reports what it knows on its status
resource.

Create `connector/` at the repository root as a second TypeScript package alongside
`gateway/`, with the same constraints the gateway holds: `"type": "module"`, Node 24 or
newer, `tsc` for building, and no runtime dependencies outside the Node standard library. A
new runtime dependency in either package must be recorded in this Decision Log with its
rationale before it is added. Keep the two packages separate rather than merging them: the
connector is code that ships into someone else's application and must stay small enough that
installing it is not a decision, while the gateway is a service. Merging them would make it
impossible to see when the connector is growing.

Inside `connector/src/`, keep four pieces separate.

`connector/src/call.ts` is the entry point the customer's application uses. It exposes a
single function taking a chat-completion request plus an optional workload name and returning
the provider's response. Internally it consults the currently held ranked list, calls the
first provider in it directly with the customer's own provider credential, and — this is the
connector's one and only routing rule — retries against the next provider in the list if the
call fails with a network error, a 429, or a 5xx. It never evaluates a target, never measures
a percentile, and never decides anything the gateway could have decided for it. When no list
has ever been received, it calls a statically configured fallback provider, which is what
makes the connector safe to install before the gateway is reachable.

`connector/src/channel.ts` maintains the connection to the gateway. It opens a
`GET /v1/connector/stream` request to the gateway and holds it open, reading Server-Sent
Events — a plain HTTP response the server keeps open and writes lines into, which is used
here rather than WebSockets because it needs no protocol upgrade, survives ordinary HTTP
proxies, and only ever sends data in one direction. Each event carries a ranked list for one
workload and a monotonically increasing version number. On receiving one, the connector
stores it and immediately `POST`s the version back to `/v1/connector/ack`. If the stream
drops, reconnect with exponential backoff up to roughly thirty seconds, and while
disconnected poll `GET /v1/connector/lists` every thirty seconds; the polling path is the
documented degraded mode, and the gateway can tell the two apart because a polled list is
acknowledged much later than a pushed one.

`connector/src/report.ts` batches usage reports and `POST`s them to `/v1/connector/usage`
every ten seconds or every hundred requests, whichever comes first. Each record carries the
workload, the provider actually used, the model and the provider's serving region, the prompt
and completion token counts as the provider reported them, the provider-attributable latency
in milliseconds, the **response status code** and any rate-limit limit/reset headers the
provider returned, and — for M2 — the reservation identifier if the request addressed one.
Reports are fire-and-forget and buffered in memory: reporting must never be able to slow down
or fail a customer's request.

One record serves two consumers with different tolerances for loss, and the buffering differs
accordingly. As a **usage** record it computes the bill, and losing one degrades a figure the
specification already takes as reported rather than audited — so the usage queue is bounded
and **drops oldest first**. As a **strain contribution** it feeds behavior 3's aggregate
(product specification, [Collective strain
signals](../../product-specs/provider-risk-management-gateway.md#collective-strain-signals-in-detail)),
and there drop-oldest is actively wrong: a rate-limit storm is a burst, a burst overflows the
queue, and dropping by age discards the onset of the exact event the cohort exists to detect.
It also fails asymmetrically — the customers hit hardest lose the most evidence, so the
aggregate would systematically understate severe strain. The strain buffer is therefore its
own small bounded queue that sheds load by **sampling rather than by age**, preserving the
shape of a burst instead of its tail, and records its own drop rate so the aggregate knows
what it is missing.

The status code matters rather than a success boolean because 429 and 5xx are distinct
signals, and the limit/reset headers matter because the specification excludes 429s
attributable to the customer's own quota from strain — without those headers that exclusion
cannot be made. Nothing here aggregates across customers: cohort membership, banding, and
disclosure all stay with behavior 3.

`connector/src/headers.ts` adds the response header the specification requires. When the
gateway's most recent push says the workload is unmet, the connector sets
`x-gateway-target-unmet: <dimension>` on the response it returns to the calling application,
so the header lands in the customer's own logs. The gateway cannot write this header itself
because it never sees the response.

Streaming: when the customer's request asks for a streamed response, the connector must relay
the stream to the caller as it arrives, without buffering the whole body, and count tokens
when the stream ends. It never inspects or rewrites chunks. Prove this explicitly in the
verification below, because a connector that quietly buffers looks correct in every test that
does not measure time-to-first-byte.

On the gateway side, add `gateway/src/controlplane/` holding the three connector-facing
endpoints above, plus the code that computes a ranked list. Computing it is deliberately not
new logic: call the existing `chooseProvider` once per candidate provider against the current
state snapshot and sort by its decision, so the ranked list and an in-path per-request choice
come from the same function. Push a new list when the target document changes, when a
workload enters or leaves `unmet`, or when measured provider state changes the order — and
debounce to at most one push per workload per second, so a flapping provider cannot turn into
a push storm.

Authentication arrives here because it must. Add a `connectors` table to the existing SQLite
store holding a connector token, the customer it belongs to, and a creation timestamp; add
`POST /v1/admin/connectors` to mint one, guarded by a `GATEWAY_ADMIN_TOKEN` environment
variable. Every connector endpoint requires `Authorization: Bearer <token>` and resolves the
customer from it. The customer key column that the design document describes as carrying a
single hardcoded value now carries the real customer, and every store query is scoped by it.
This is authentication and per-customer scoping only — it is not the cohort machinery
behavior 3 will need, and nothing here should try to anticipate that.

Add `connector/src/dev/sampleApp.ts`, a small program that calls `call.ts` in a loop against
the stub providers, so the whole path is demonstrable without a customer.

Completion criterion: the sample application's traffic reaches stub providers with no request
passing through the gateway; changing a target through `PUT /v1/targets` changes which stub
the sample application calls within five seconds; the gateway's status resource shows token
counts that only the connector could have supplied; killing the gateway leaves the sample
application working; and a streamed request reaches the caller incrementally.

Verification: from the repository root, build and start everything —

    npm --prefix gateway install
    npm --prefix gateway run build
    npm --prefix connector install
    npm --prefix connector run build

Start two stub upstreams on different ports with different simulated latency and cost, start
the gateway, mint a connector token with the admin endpoint, and start the sample application
with that token. Then, each producing its named artifact under *Artifacts and Notes*:

- With the gateway's own HTTP access log visible, run the sample application for a minute and
  confirm **no** chat-completion request appears in it, while both stub upstreams show
  traffic. This is the whole architecture in one observation.
- `PUT` a target that makes the cheaper, slower stub the only satisfying choice; confirm from
  the stubs' logs that the sample application's traffic moves within five seconds, and that
  the gateway recorded an acknowledgement carrying the version it pushed.
- `GET /v1/workloads/default/status` and confirm it reports token counts and latency the
  gateway could only have learned from the connector's reports.
- Kill the gateway process. Confirm the sample application keeps calling the last-directed
  stub with no errors, that its reconnect attempts back off rather than spinning, and that
  nothing is lost when the gateway is restarted.
- Block the gateway's SSE endpoint (a firewall rule, or a flag on the stub) so only polling
  succeeds; confirm the connector still receives lists, and that the gateway can see the
  acknowledgement delay is large. This is the degraded mode the specification requires be
  detectable.
- Issue a streamed request through the connector and record time-to-first-byte against a
  stub that emits chunks one second apart. Expect the first chunk at roughly one second, not
  after the last chunk. A buffering connector fails here and passes everything else.
- Drive the workload into `unmet` as the predecessor plan describes, and confirm the sample
  application's responses now carry `x-gateway-target-unmet` — written by the connector, on a
  response the gateway never saw.

Then run `python scripts/harness-validate.py .` and `python scripts/check.py`, and update
`AGENTS.md`'s command list and `docs/harness/manifest.yaml` with the connector's build,
start, and test commands.

Rollback and recovery: additive — a new top-level directory, new gateway endpoints on new
paths, and one new table. Revert the commit to recover. The store change is additive; no
existing table is altered. Re-running install, build, and the processes is always safe.

Escalate when: holding the ranked list in the connector turns out to need weights rather than
an ordering to express a target the gateway can otherwise satisfy — that contradicts ADR
`0006`'s residual assumption and is a product question, not an implementation one. Also
escalate if authentication cannot be added without a runtime dependency, since that crosses a
constraint the predecessor plan set.

### M2 — Reservation-aware routing

Goal: implement product specification behavior 4. A customer declares provider capacity they
have already paid for; the gateway tells them when their traffic is not using it, and routes
eligible traffic onto it ahead of pay-as-you-go capacity.

This milestone is small because M1 built the hard parts. What it adds is a resource, a
utilization calculation, a report, and a routing preference.

Add the reservation resource: `GET`/`PUT /v1/reservations`, versioned with the same
optimistic-concurrency rule the target document uses, so a write must supply the version it
replaces and gets `409` on a mismatch. A reservation carries a customer-chosen identifier,
the host, the model, the size in whatever unit that host sells (Bedrock model units, Azure
provisioned throughput units), the term's start and end, the effective rate per thousand
tokens, and the host-specific string that actually addresses it — the provisioned model ARN
on Bedrock, the deployment name on Azure. **This is a separate document from the target
document**, for the reason in the Decision Log: a term expiring must not silently change what
a target means.

Compute utilization from the connector's own usage reports, not from the provider. Both
reasons are recorded in the specification and neither is negotiable here: Azure publishes a
utilization metric but Azure Monitor lags between thirty seconds and fifteen minutes against
a five-minute measurement window, and Bedrock publishes no utilization figure at all. A
read-only cloud credential may be offered later as optional corroboration; requiring one
would be a far heavier install than the connector itself.

Surface unaddressed capacity. For each declared reservation, compare the traffic that *could*
have addressed it — requests for that model, on that host, inside the term — against the
traffic that actually did, which the connector reports by including the reservation
identifier when it addresses one. Report the gap on the status resource with the concrete
cause where it is knowable: the most common one is a call site passing the foundation model
identifier rather than the provisioned identifier, which the connector can see directly
because it sits at the call site.

Extend routing. In `chooseProvider`, a provider that addresses a live reservation for the
requested model gets preference over on-demand capacity, and its cost is the reservation's
effective rate rather than the catalogue's public rate. This makes
`cost_per_1k_tokens_usd` customer-specific for the first time, which the capability
catalogue's global key does not express — reconciling that is tracked in
[#12](https://github.com/hoomji/henry-ai-router/issues/12) and this milestone should read
that ticket's resolution before implementing the floor lookup rather than inventing a second
scheme. The preference is a preference, not an override: a reservation never wins over a
`hard` dimension, and it never overrides `allowed_models`, because that list is the
customer's blast radius and a reservation is not permission to leave it.

The ranked list M1 pushes now naturally puts the reservation-addressing provider first, and
the connector uses the reservation's addressing string when calling it — which is the whole
behavior, delivered through machinery that already exists.

Completion criterion: a declared reservation that traffic ignores is reported as unaddressed
with its cause; after the reservation is declared, eligible traffic routes onto it ahead of
on-demand capacity; a reservation never causes a route outside `allowed_models` or a breach
of a `hard` dimension; and no provider credential is ever granted to the gateway.

Verification: extend the two stubs so one of them accepts a reservation-addressing identifier
and reports a distinct model name when addressed that way. Then, each producing its named
artifact:

- Run the sample application configured to pass the plain model identifier, declare a
  matching reservation, and confirm the status resource reports the reservation as
  unaddressed and names the call-site cause.
- Confirm the sample application's traffic then moves onto the reservation-addressing path,
  visible in the stub's log as the distinct model name, without the sample application's own
  code changing.
- `PUT` a reservation for a model that is not in the workload's `allowed_models` and confirm
  traffic does **not** move onto it.
- Declare a reservation whose effective rate would satisfy a `cost_per_1k_tokens_usd` target
  that the public rate cannot, and confirm the target is now held — this proves the
  customer-specific cost floor is actually reaching the routing decision.
- `PUT` a reservation twice with the same version and expect `409` on the second.
- Confirm the gateway holds no provider credential anywhere in its configuration or store at
  the end of the run.

Then run `python scripts/check.py`.

Rollback and recovery: additive — new endpoints, a new table, and a branch inside
`chooseProvider` that is inert when a customer has declared no reservations. Revert to
recover. Because this milestone publishes a customer-facing HTTP contract, treat a revert
after that contract has been exposed to a real customer as a breaking change rather than a
discard.

Escalate when: reservation eligibility turns out to need per-request knowledge the connector
cannot supply, or when the customer-specific cost floor cannot be expressed without
restructuring the capability catalogue — the latter is [#12](https://github.com/hoomji/henry-ai-router/issues/12)'s
question and is owned by the specification, not by this plan.

## Concrete Steps

Planned commands, all from the repository root. Replace them with the actually-run commands
as work proceeds.

    python scripts/setup.py
    npm --prefix gateway install
    npm --prefix gateway run build
    npm --prefix connector install
    npm --prefix connector run build
    npm --prefix connector test
    npm --prefix gateway test
    python scripts/harness-validate.py .
    python scripts/check.py

The commands that start the stubs, the gateway, and the sample application are recorded in
each milestone once the implementation exists, and must also land in `AGENTS.md`'s command
list and in `docs/harness/manifest.yaml`.

## Validation and Acceptance

The plan is complete when a novice, following the commands in `AGENTS.md`, can observe all of
the following. First, that the sample application's traffic reaches stub providers while the
gateway's access log shows no chat-completion requests at all — the gateway is out of the
path. Second, that editing a target through the management API changes which provider the
sample application calls within five seconds, and that the gateway recorded the connector's
acknowledgement of the list it pushed. Third, that killing the gateway leaves the sample
application working. Fourth, that a streamed response reaches the caller incrementally rather
than after completion. Fifth, that a workload in `unmet` produces a response header on a
response the gateway never saw. Sixth, that a declared reservation which traffic ignores is
reported as unaddressed with its cause, and that eligible traffic then moves onto it without
the calling application changing, while never leaving `allowed_models`.

Automated proof: `python scripts/check.py` passes, plus both packages' test commands.

This evidence maps to the product specification's acceptance criteria for the connector, for
behavior 4, and to the criterion that a workload in `unmet` carries the header on a request
the gateway never saw. The specification's criteria for behaviors 2, 3 and 5 stay open and
unclaimed, as their entries in *Behavior sequence and deferrals* record.

One qualification on behavior 3: this plan makes the connector *contribute*, so a usage
record carries a status code, a cell key, and rate-limit headers, and the strain buffer sheds
by sampling. It aggregates nothing and discloses nothing, so none of behavior 3's acceptance
criteria are claimed here. What can be observed is narrower and should be checked: a stub
provider returning 429s produces records carrying the status code and the provider's
limit/reset headers, and a burst of them does not evict the burst's onset from the buffer.

## Idempotence and Recovery

Both milestones are additive: new directories, new HTTP paths, new store tables, and a branch
in `chooseProvider` that is inert until a reservation exists. No existing table is altered and
no data is migrated. Reinstalling dependencies, rebuilding, and restarting the gateway, the
stubs, the sample application, or the connector are safe at any time and in any order — the
connector is specifically designed to survive the gateway being absent, which makes restart
ordering irrelevant. Document edits and new directories are recoverable with `git revert`.

The one irreversible-feeling step is minting connector tokens, and it is not: a token is a row
in the store, and deleting it revokes the connector, which then falls back to its statically
configured provider exactly as it does before its first list arrives.

## Artifacts and Notes

None yet. Add M1's access-log observation, its target-switch transcript, its
time-to-first-byte measurement, and M2's unaddressed-reservation report and routing
transcript here as they are produced.

## Interfaces and Dependencies

- `GET /v1/connector/stream` — Server-Sent Events; each event carries one workload's ranked
  list plus a version. The gateway's only push channel.
- `POST /v1/connector/ack` — the connector confirms a version. What bounds the audit record
  behavior 2 will later depend on, and what makes the polling fallback detectable.
- `GET /v1/connector/lists` — the polling fallback, used only while the stream is down.
- `POST /v1/connector/usage` — batched usage records; the source of every token count in
  *spend under management*, of every measurement behind a target, and of every *strain
  contribution* behavior 3 will later aggregate. One endpoint, one record, two loss
  tolerances: see M1's `report.ts` task.
- `POST /v1/admin/connectors` — mints a connector token, guarded by `GATEWAY_ADMIN_TOKEN`.
- `GET`/`PUT /v1/reservations` — M2's reservation resource, versioned with the same
  optimistic concurrency as the target document, `409` on a stale version. Separate from the
  target document by decision.
- `Authorization: Bearer <token>` on every connector endpoint; the customer is resolved from
  the token and every store query is scoped to it.
- `x-gateway-target-unmet: <dimension>` — written by the connector onto the response returned
  to the calling application.
- `chooseProvider(request, state): RoutingDecision` — unchanged in signature and still pure.
  M1 calls it once per candidate to build a ranked list; M2 adds reservation preference and a
  customer-specific cost inside it. Its purity is what lets one function serve both the
  ranked list and a future in-path decision.
- Runtime: Node.js 24 or newer for both packages, TypeScript compiled with `tsc`, Node
  standard library only (`node:http`, global `fetch`, `node:sqlite`). Any third-party runtime
  dependency must be recorded in the Decision Log with rationale before being added. The
  repository's Python harness scripts are unaffected and remain the validation entrypoints.

## Revision Note

2026-08-15 — Created this plan to carry the work after the tracer, following grilling ticket
[#8](https://github.com/hoomji/henry-ai-router/issues/8), which resolved the behavior
sequence. It is a separate plan rather than further milestones on
[`2026-08-14-provider-risk-gateway-tracer.md`](2026-08-14-provider-risk-gateway-tracer.md)
because that plan's stated destination is its own two milestones and its scope explicitly
excludes behaviors 2 through 5; extending it would have made its own scope untrue. The
sequencing decision, the routing-authority decision, and the four consequential choices that
followed from them (reservations as a separate resource, streaming split between connector
and adapter contract, authentication without cohort multi-tenancy, and which component writes
which response header) are all recorded in the Decision Log above and in the product
specification's *Behavior sequence and deferrals* section.
