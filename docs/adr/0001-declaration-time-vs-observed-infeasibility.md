# Declaration-time and observed infeasibility are two states, not one

Status: accepted (2026-08-15), amended in part (2026-08-15) by ADR
[`0003`](0003-provenance-tiered-capability-catalogue.md)

> **Amendment note.** The two-state model below is unchanged and remains in force. What
> ADR 0003 narrows is the *strength* of the declaration-time claim: because no provider
> publishes a latency floor and a per-model floor is wrong in both directions
> ([#11](https://github.com/hoomji/henry-ai-router/issues/11)),
> `infeasible_by_declaration` now means "no allowed provider **plausibly** can satisfy
> this" rather than "no allowed provider can." A target is rejected only when it fails
> the most optimistic candidate floor by more than that floor's own variance, and the
> check may **abstain** — accepting the write — when every floor for a key has expired.
> Read the closing paragraph of this record, on the catalogue accepted as a cost, as
> superseded by ADR 0003.

The product specification requires that a target no provider mix can satisfy be
"reported, not silently best-effort." Resolving what that means
([#6](https://github.com/hoomji/henry-ai-router/issues/6)) surfaced that the phrase
covers two conditions with different truth conditions: a target no allowed provider *can*
satisfy, knowable before any traffic flows, and a target no provider mix *has* held over
a measurement window, knowable only after running. We model them as two named states —
`infeasible_by_declaration` and `unmet` — rather than one "infeasible."

## Considered options

**One state.** Simpler, and the shape most systems ship. Rejected because collapsing them
forces a choice between two bad outcomes: either the state is raised only at runtime, in
which case a customer can deploy a target that was arithmetically impossible on the day
they wrote it and wait a window to find out — or it is raised at write time, in which
case there is no vocabulary left for a target that was feasible and then stopped holding
because a provider degraded. The specification's guarantee is really about the first
case, and a single state cannot express it.

**Two states.** Chosen. Declaration-time infeasibility rejects the write synchronously,
so an impossible target cannot be deployed at all. `unmet` is a runtime state with
hysteresis (two consecutive missed windows to enter, two held to leave) because it is
tied to notifications, and an alert that toggles every few minutes gets muted — which
would defeat the reporting guarantee it exists to provide.

## Consequences

This is hard to reverse because three contracts are shaped by it and would all have to
change together:

- The per-workload status resource exposes the state, so its schema encodes the
  distinction.
- The notification fires on `unmet` transitions only — declaration-time infeasibility has
  no transition to notify about, because the write never succeeded.
- The routing decision must return a *binding reason* alongside the chosen provider, not
  merely the provider. Both reports are specified as diagnoses rather than alarms, and a
  reason reconstructed after the fact from logs is not trustworthy. This constrains the
  routing seam's return type from the first milestone onward.

The cost accepted in exchange: declaration-time checking requires the gateway to hold a
declared capability floor per allowed model, which is a catalogue it must maintain and
keep honest, and `allowed_models` becomes a required field rather than an optional one so
that the check has a finite candidate set.
