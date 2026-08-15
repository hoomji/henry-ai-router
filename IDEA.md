# AI Router/Gateway Ideas

## Five ideas  

1. **Usage-decay pricing** — price/reclaim idle reserved provider capacity a customer pre-provisioned but isn't using, instead of only billing per-call/per-token.
2. **Incident-only routing** — a router that's bypassed/invisible during normal operation, only intercepts (and only charges) during a detected incident (rate-limit storm, outage, deprecation) — like a harbor pilot who boards only for the hard part.
3. **Target-state routing** — customer states an outcome (e.g. "p95 < 400ms, cost < $Y/mo") instead of a routing rule; gateway continuously renegotiates provider mix to hold that target proactively, not reactively.
4. **Collective fatigue-aware routing** — share anonymized provider-fatigue/rate-limit signals across the whole customer base so routing shifts away from a strained provider before anyone hits a 429 (network-effect moat via shared data, not per-tenant config).
5. **Semantic-fidelity prompt translation** — go beyond structural/API normalization (unified schema) to preserve *intended behavior* per-model, since different models interpret the same instructions differently (system prompts, tool-call formats, refusal behavior).

## Meta-pattern identified

All five ideas treat the provider relationship as adversarial/uncertain (provider might fail, degrade, run out) rather than cooperative/known (which is how existing routers' feature sets — routing, catalog, dashboards — are built). **Nobody in the AI-router space sells "provider risk management" as its own product category** — it's currently only handled ad hoc via basic fallback.
