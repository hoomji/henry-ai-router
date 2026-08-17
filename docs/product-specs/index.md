# Product specifications

What this repository is required to do for its users, separately from how it is built.
Write and revise specifications with `harness-product-spec` using
[`template.md`](template.md). Every specification appears in the table below exactly once.

State vocabulary: `Draft`, `Accepted`, `Delivered`, `Superseded`.

| Specification | User and problem | State | Delivery evidence | Owner | Reviewed |
|---|---|---|---|---|---|
| [provider-risk-management-gateway.md](provider-risk-management-gateway.md) | Teams on hosted AI providers exposed to provider failure, degradation, and idle-capacity waste | Accepted | Partial — behaviors 1 and 4 and the connector, proven by `npm --prefix gateway run e2e` and `run load` at `e20ebea`; behaviors 2, 3, 5 unclaimed. See the spec's [Delivery evidence](provider-risk-management-gateway.md#delivery-evidence) | henry.tran@uniblock.dev | 2026-08-16 |

## Entry contract

- One specification owns one user-facing problem; split rather than accumulating.
- Every required behavior maps to at least one observable acceptance criterion, and no
  acceptance criterion prescribes incidental implementation.
- `Delivered` requires named delivery evidence: a merged change, a passing check, or an
  observable runtime surface.
- A superseded specification keeps its file and gains a successor link; delivered history
  is not erased.
- Implementation sequence belongs in `docs/exec-plans/`; architectural trade-offs belong
  in an ADR.
