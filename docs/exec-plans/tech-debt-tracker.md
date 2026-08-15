# Technical debt tracker

Known, accepted shortcuts in this repository. An item belongs here when the repository
works today but a future change will be harder or riskier because of a deliberate choice.
A defect belongs in the issue tracker instead.

| ID | Debt | Location | Incurred by | Cost if unpaid | Trigger to pay | Owner | Recorded |
|---|---|---|---|---|---|---|---|

_No recorded debt._

## Entry contract

- `Location`: repository-relative paths an agent can open, not a prose description.
- `Incurred by`: the plan, ADR, or change that accepted the shortcut, so the trade-off is
  recoverable.
- `Cost if unpaid`: the concrete work this makes harder, not a severity adjective.
- `Trigger to pay`: the observable condition that makes repayment worthwhile, so items
  can be closed on evidence rather than age.
- Remove an item when the debt is paid; record it in the paying change, not here.
- Debt that has become a defect moves to the issue tracker and is removed from this file.
