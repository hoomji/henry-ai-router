# The target document lives in a durable store designed for concurrent writers

Status: accepted (2026-08-15)

Behavior 1, as specified after
[#6](https://github.com/hoomji/henry-ai-router/issues/6), introduced three pieces of
state: a versioned target document with optimistic concurrency, per-workload measurement
windows, and a per-customer notification signing secret. Persistence had been listed as
premature-before-the-tracer alongside multi-tenancy and authn. It no longer is: the target
document is customer-authored configuration, and `unmet` is a customer-visible state
reported on three surfaces, so an in-memory implementation means a deploy silently resets
a customer's target state and may drop or duplicate the notification they were relying on
([#13](https://github.com/hoomji/henry-ai-router/issues/13)).

We store the target document and the `unmet` state machine in a durable store designed
from the first milestone for **concurrent writers across processes**, with optimistic
concurrency enforced by the store rather than by a single-writer assumption. The store is
SQLite in WAL mode via Node's built-in `node:sqlite`.

## Considered options

**In-memory until the first real customer.** The cheapest option, and the one the design
document previously assumed. Rejected because M2's own acceptance criteria are about
customer-visible target state, and a state machine that resets on restart cannot
demonstrate them honestly — the milestone would be testing a behavior it does not
implement. Deferring also means the store arrives under time pressure, next to a real
customer's data, rather than against simulated providers.

**Durable, single writer.** One gateway process owns the store; concurrency is an
in-process mutex plus a version compare. Materially simpler, and sufficient for the
tracer. Rejected because it is not a simplification that can be relaxed later: the
measurement windows, the sample floor, the `unmet` evaluation, and notification
de-duplication all have different designs under one writer than under several, and
choosing the single-writer shape would mean undoing four decisions rather than swapping a
store. Running a second process against a single-writer design would not fail loudly — it
would corrupt the version discipline quietly.

**Durable, concurrent writers.** Chosen. The store provides transactional
compare-and-set, which serves both the `409` on the target document and the
de-duplication of `unmet` notifications, so one primitive covers two problems that would
otherwise need separate machinery.

**Postgres rather than SQLite.** Rejected for now. SQLite in WAL mode gives genuine
cross-process transactional CAS through file locking, which covers concurrent processes on
one host — the concurrency actually in scope. Postgres additionally covers multiple hosts,
at the cost of an external service the tracer must start and a driver dependency. Moving
from one to the other is a store swap behind the same interface, not a redesign.

**`better-sqlite3` on Node 20 rather than raising the engines floor.** Rejected. It would
be this repository's first runtime dependency and a native module, turning `npm install`
into a compiler invocation. The engines floor moves from Node 20 to Node 24, where
`node:sqlite` is built in and stable, keeping runtime dependencies at zero.

## Consequences

This is hard to reverse because five things are shaped by the concurrency choice and
would have to change together:

- **Measurement windows stay in memory, but are merged.** Each process keeps its own
  rolling window and persists a *window summary* at each window close, tagged with a
  process identifier and the window-close timestamp. The `unmet` machine evaluates over
  the merged summaries whose close falls in the current window; older rows are pruned at
  evaluation, so a crashed process's contribution ages out within one window without any
  liveness detection. The sample floor is therefore workload-wide across merged
  summaries, not per-process.
- **The `unmet` transition is a compare-and-set.** The process that wins the CAS sends
  the notification; the others observe the version move and stay silent. Without this,
  N processes fire N notifications for one transition, which reads to a customer as a
  flapping target — the thing the symmetric two-window rule exists to prevent.
- **The data path reads an in-memory copy, refreshed by polling.** The store is never
  read synchronously while serving a request. Each process polls the document version on
  a short interval and swaps its copy when it changes, which makes propagation bounded
  rather than instant: `PUT /v1/targets` returning `200` means *committed*, not *in force
  in every process*.
- **`409` is terminal.** The gateway never retries a rejected write on the client's
  behalf; the client re-reads and re-decides, and `PUT` is a whole-document replace. This
  is what makes livelock impossible — there is no retry loop in our contract to livelock
  in. Field-level merge across workloads would allow a dashboard edit and a deploy to both
  succeed, but merge semantics over a document with cross-workload validation is a design
  of its own and is not taken here.
- **Deployment topology could not be kept fully out of scope.** Multi-tenancy and authn
  remain non-goals — the store carries a customer key column with a single hardcoded
  value and no API surface — but designing for concurrent writers presumes more than one
  gateway process, which is a topology commitment. It is made deliberately here rather
  than discovered later.

The cost accepted in exchange: M2 grows a real store and a schema against simulated
providers, the engines floor moves to Node 24, and a scale-down can drop a workload's
merged sample count below the floor so it reports `insufficient_data` — correct behavior
that will look like a regression to a reader who does not know the merge rule.

The notification signing secret is deliberately **not** in this store. It is a credential
with a different lifecycle, and putting it alongside customer-authored configuration would
make every backup, dump, and document read path a secret-handling path. It stays in the
config surface.
