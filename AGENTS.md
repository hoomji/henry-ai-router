# Agent guidance

This repository is a product-exploration repository for an AI router/gateway. Most of it
is documentation — the product thinking, its decisions, and the harness that keeps them
reviewable. It also contains two runtimes:

- The **gateway** under [`gateway/`](gateway/) — a control plane that holds the target
  document and the reservation document, measures rolling windows, reports `unmet`, and
  pushes ranked provider lists to connectors. It keeps a forwarding data path, but in
  normal operation it is *not* in the request path.
- The **connector** under [`connector/`](connector/) — the component that installs into a
  customer's own application at the place where their code calls a provider. It makes that
  call itself, directly, obeying the ranked list the gateway pushed it. This is where
  provider calls actually happen.

Nothing is deployed anywhere, and no provider credential or cloud account is needed for any
command in this repository except one: `npm --prefix gateway run real-provider-check` is
opt-in, requires `PROVIDER_API_KEY`, and is the only command that reaches a real provider.
See [the learning ledger](docs/harness/learning-ledger.md) for why it exists.

Both runtimes are deliberately small, and both hold the same constraint: `"type": "module"`,
Node 24 or newer, built with `tsc`, and no runtime dependencies outside the Node standard
library. Read
[`docs/exec-plans/completed/2026-08-14-provider-risk-gateway-tracer.md`](docs/exec-plans/completed/2026-08-14-provider-risk-gateway-tracer.md)
and
[`docs/exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md`](docs/exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md)
before extending either: what each is *for*, and what it deliberately is not, is stated
there and is not inferable from the code. The second of those also records why the gateway
being out of the request path means connector-reported usage is the *only* input the
measurement windows have — a fact that is easy to break invisibly.

## Repository map

- Human-facing orientation: [`README.md`](README.md) — the outside view; keep its status
  claims in step with the specification's delivery evidence
- Architecture and boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Gateway runtime: [`gateway/`](gateway/) — layout and seam rules in
  [`docs/design-docs/gateway-design.md`](docs/design-docs/gateway-design.md)
- Connector runtime: [`connector/`](connector/) — the customer-installed component that
  calls providers directly
- Decisions: [`docs/adr/`](docs/adr/), numbered `NNNN-short-slug.md`
- Domain language: [`CONTEXT.md`](CONTEXT.md) — glossary only, no behavior or decisions
- Harness capability state: [`docs/harness/manifest.yaml`](docs/harness/manifest.yaml)
- Representative workflow: [`docs/harness/tracer-workflow.md`](docs/harness/tracer-workflow.md)
- Repeated-friction ledger: [`docs/harness/learning-ledger.md`](docs/harness/learning-ledger.md)
- Documentation audit routine: [`docs/harness/docs-audit.md`](docs/harness/docs-audit.md)
- Harness capability report: [`docs/harness/quality-report.md`](docs/harness/quality-report.md)

## Knowledge store

Start here, then follow the index that owns the question. Each store's index states its
own entry contract; nothing in these directories is authoritative unless its index lists
it.

- Required product behavior: [`docs/product-specs/index.md`](docs/product-specs/index.md)
- Design documentation and verification status: [`docs/design-docs/index.md`](docs/design-docs/index.md)
- Agent-first operating principles: [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)
- Active and completed execution plans: [`docs/exec-plans/index.md`](docs/exec-plans/index.md)
- Accepted technical debt: [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md)
- ExecPlan authoring instructions: [`PLAN.md`](PLAN.md)
- External reference material: [`docs/references/index.md`](docs/references/index.md)
- Generated documentation, never hand-edited: [`docs/generated/index.md`](docs/generated/index.md)

## Common commands

Run these from the repository root. The interpreter name is not portable across the
machines this repository has been worked on, so check before assuming: `python` resolved on
the machine where the tracer was built, and on the Windows machine where the connector was
built only the `py` launcher (Python 3.12.10) resolves — `python` and `python3` both fail
there. The commands below are written with `python`; substitute `py` if that is what your
machine has. The scripts themselves are interpreter-agnostic and need Python 3.10 or newer.

- Setup: `python scripts/setup.py`
- Focused check: `python scripts/harness-validate.py .`
- Full verification: `python scripts/check.py` — prerequisites, the harness contract,
  repository-local Markdown links, and both runtime test suites. Each runtime's `test`
  script builds first, so the gate typechecks both runtimes as well. Add `--e2e` to
  include `npm --prefix gateway run e2e`; it is out of the default gate because it binds
  ports and starts processes.
- Harness validation: `python scripts/harness-validate.py .`
- Documentation audit: `python scripts/docs-audit.py` — advisory, exits 0 and prints
  candidates. It reports the documentation drift the gate cannot see: prose contradicting
  what the repository contains, store documents missing from their index, orphaned
  documents, `Reviewed:` dates past the 90-day budget, path references to a moved ExecPlan
  in Markdown, YAML, TypeScript or Python, and leftover placeholder text. Add `--strict` to
  make a finding fail. The full routine, including the four passes that need a reader, is
  [`docs/harness/docs-audit.md`](docs/harness/docs-audit.md).

[`.github/workflows/gate.yml`](.github/workflows/gate.yml) runs that same gate on every
push and pull request, plus the end-to-end run as a separate job. It calls
`scripts/check.py` rather than restating its steps, so CI and a local run cannot disagree
about what passed. CI installs both runtimes first, because `scripts/setup.py` reports on
dependencies but deliberately does not install them.

The gateway runtime has its own commands. `npm --prefix gateway install` is its setup, and
`build` must run before `start` or `stub` because the tracer runs compiled JavaScript.

- Install: `npm --prefix gateway install`
- Build: `npm --prefix gateway run build`
- Start: `npm --prefix gateway run start` — requires `UPSTREAM_BASE_URL`; `PORT` defaults
  to 8080, and `FORCE_ROUTER_ERROR=1` makes the routing seam throw so the fail-open path
  is observable
- Stub upstream: `npm --prefix gateway run stub` — a canned-completion provider on
  `STUB_PORT` (default 8081), so the tracer runs with no provider credentials
- Test: `npm --prefix gateway test`
- Load run: `npm --prefix gateway run load` — M2's evidence artifact. It starts simulated
  providers, warms up until every provider has been genuinely measured, then drives traffic
  through two workloads with different targets, prints the traffic split and the measured
  p95, and exits non-zero unless the split moves with the target in the right direction.
  The warm-up is not optional: the routing seam deliberately prefers an unmeasured provider,
  because a provider that is never chosen can never be measured, so a run without it
  measures the exploration transient rather than the routing policy.
- End-to-end run: `npm --prefix gateway run e2e` — the connector plan's evidence artifact,
  and the single command that demonstrates the product's central claim. It starts the stub
  providers, the gateway and the sample applications itself, then drives seven checks and
  exits non-zero if any fails: no chat-completion request in the gateway's access log, a
  target switch taking effect within five seconds with the connector's acknowledgement
  recorded, connector-supplied token counts on the status resource, the sample application
  surviving the gateway being killed, the polling fallback being detectable by its
  acknowledgement delay, streaming time-to-first-byte well before the stream ends, and
  `unmet` reached on connector reports alone with no in-path traffic.
- Gateway with an access log: `npm --prefix gateway run gateway:logged` — the same gateway
  writing an HTTP access log, so the "no chat-completion request reaches the gateway"
  observation can be made by eye rather than only by the e2e script.
- Runtime snapshot: `npm --prefix gateway run inspect` — read-only, needs no running gateway,
  and answers the question a failing `e2e` or `load` run raises: *what does the control plane
  currently believe?* It prints the target and reservation versions, reservation liveness, the
  merged measurement window per provider, whether each connector has acknowledged the list
  version it was pushed (the `STALE` marker is usually the real cause when routing "looks
  wrong"), reported token counts, and the ranked list itself. The order is produced by calling
  `computeRankedList`, the same function the control plane pushes from, so the view cannot
  disagree with what connectors were sent. Point it at a store with `--store <path>` or
  `GATEWAY_STORE_PATH`, select a customer with `--customer`, and add `--json` when something
  downstream is reading. Connector tokens are printed truncated. Set `GATEWAY_PROVIDERS` as
  the gateway had it, or the ranked list is computed against a catalogue the gateway was not
  running — the output names which source it used.
- Real-provider check: `npm --prefix gateway run real-provider-check` — the one command
  allowed to leave the laptop. It starts a real gateway, mints a connector token, and makes
  the connector place exactly one real call against a real provider through
  `connector/src/dev/realProviderProbe.js`, defaulting to a free OpenRouter model. Requires
  `PROVIDER_API_KEY`; fails with remediation rather than skipping quietly when it is unset.
  Never run by `scripts/check.py` or CI, and it is a smoke test, not a measured capability
  floor — one passing call proves the path is reachable today, nothing about a percentile.
  See [the learning ledger](docs/harness/learning-ledger.md) for why this exists.

The connector runtime is a second package with its own install and build. Build before any
of its run commands, for the same reason as the gateway: they execute compiled JavaScript.

- Install: `npm --prefix connector install`
- Build: `npm --prefix connector run build`
- Test: `npm --prefix connector test`
- Sample application: `npm --prefix connector run sample` — calls providers in a loop
  through the connector, so the whole path is demonstrable without a customer
- End-to-end sample application: `npm --prefix connector run e2e-app` — the variant the
  gateway's `e2e` run drives
- Streaming probe: `npm --prefix connector run stream-probe` — measures time-to-first-byte
  against a stub emitting chunks a second apart. A connector that quietly buffers passes
  every other check and fails this one, which is why it has its own command.
- Real-provider probe: `npm --prefix connector run real-provider-probe` — makes exactly one
  call and exits; not meant to be run alone, it is what the gateway's `real-provider-check`
  spawns with credentials, a token and a real provider URL already in its environment.

The connector's configuration is environment-only, and `connector/src/config.ts` is the one
module that reads it. `GATEWAY_URL`, `GATEWAY_CONNECTOR_TOKEN` (the bearer token minted by
`POST /v1/admin/connectors`), `CONNECTOR_FALLBACK_BASE_URL` and `CONNECTOR_FALLBACK_MODEL`
are required; `CONNECTOR_WORKLOAD` defaults to `default` and `PROVIDER_API_KEY` is optional
because the stub providers need none. The two fallback variables are required rather than
optional on purpose: they are what the connector calls before it has ever received a ranked
list, which is what makes it safe to install before the gateway is reachable.

M2 added the control plane, so the gateway now serves `GET`/`PUT /v1/targets` (`409` on a
stale version, `422` on a target that is infeasible by declaration) and
`GET /v1/workloads/{name}/status`, which is the authoritative record of a workload's
state. Requests select their workload with the `x-gateway-workload` header, and a response
carries `x-gateway-target-unmet` when the workload's target is not being held.

Every M2 environment variable is optional and defaults to M1's behavior, so the
two-variable setup above keeps working unchanged: `GATEWAY_STORE_PATH`
(`gateway-store.sqlite`), `GATEWAY_NOTIFY_SECRET`, `GATEWAY_POLL_MS` (5000),
`GATEWAY_WINDOW_MS` (300000), `GATEWAY_WINDOW_MIN_REQUESTS` (200),
`GATEWAY_SAMPLE_FLOOR` (20), `GATEWAY_NOTIFY_RETRY_MS` (900000), and `GATEWAY_PROVIDERS`
(a JSON array of provider objects; absent, it derives the single passthrough upstream from
`UPSTREAM_BASE_URL`). `config.ts` is the only module that reads the environment.

The connector work added the gateway's control-plane surface: `GET /v1/connector/stream`
(Server-Sent Events carrying a workload's ranked list and version), `POST /v1/connector/ack`,
`GET /v1/connector/lists` (the polling fallback), `POST /v1/connector/usage` (batched usage
records), `POST /v1/admin/connectors` (mints a connector token), and `GET`/`PUT
/v1/reservations` (versioned with the same optimistic concurrency as the target document,
`409` on a stale version). Every connector endpoint requires `Authorization: Bearer <token>`
and resolves the customer from it; the store's customer key column now carries the real
customer rather than a single hardcoded value.

Three more gateway environment variables came with it, all optional:
`GATEWAY_ADMIN_TOKEN` — absent, `/v1/admin/connectors` answers `404`, so a gateway with no
admin token has no mint surface at all rather than an unguarded one;
`GATEWAY_PUSH_DEBOUNCE_MS` (default 1000), the at-most-one-push-per-workload-per-second
bound that stops a flapping provider becoming a push storm; and `GATEWAY_SSE_DISABLED`
(`1` makes the stream answer `503`), which exists so the documented degraded polling mode is
demonstrable without a firewall rule.

## Working agreement

Follow the linked sources of truth. Keep changes within the requested scope. Verify the
acceptance criteria with the narrowest relevant checks, then run the repository gate when
the environment supports it. Follow the representative workflow's evidence contract.
Report skipped checks and residual risk.
