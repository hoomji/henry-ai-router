# AI Router/Gateway Ideas

## Five ideas  

1. **Usage-decay pricing** — price/reclaim idle reserved provider capacity a customer pre-provisioned but isn't using, instead of only billing per-call/per-token.
2. **Incident-only routing** — a router that's bypassed/invisible during normal operation, only intercepts (and only charges) during a detected incident (rate-limit storm, outage, deprecation) — like a harbor pilot who boards only for the hard part.
3. **Target-state routing** — customer states an outcome (e.g. "p95 < 400ms, cost < $Y/mo") instead of a routing rule; gateway continuously renegotiates provider mix to hold that target proactively, not reactively.
4. **Collective fatigue-aware routing** — share anonymized provider-fatigue/rate-limit signals across the whole customer base so routing shifts away from a strained provider before anyone hits a 429 (network-effect moat via shared data, not per-tenant config).
5. **Semantic-fidelity prompt translation** — go beyond structural/API normalization (unified schema) to preserve *intended behavior* per-model, since different models interpret the same instructions differently (system prompts, tool-call formats, refusal behavior).

## Meta-pattern identified

All five ideas treat the provider relationship as adversarial/uncertain (provider might fail, degrade, run out) rather than cooperative/known (which is how existing routers' feature sets — routing, catalog, dashboards — are built). **Nobody in the AI-router space sells "provider risk management" as its own product category** — it's currently only handled ad hoc via basic fallback.

# AI Router/Gateway Ideas

## Five ideas from random-stimulus pass

1. **Usage-decay pricing**
   - Stimulus: a library's late-fee system — penalizes slow return of a shared resource.
   - Connection: libraries penalize *holding* a shared resource too long; no router prices for holding reserved-but-unused capacity.
   - Idea: price/reclaim idle reserved provider capacity a customer pre-provisioned but isn't using, instead of only billing per-call/per-token.

2. **Incident-only routing**
   - Stimulus: a harbor pilot — boards a ship only for the dangerous part of the journey, then leaves.
   - Connection: every existing router is an always-on middleman taking a constant cut; a pilot only intervenes for the hard part.
   - Idea: a router that's bypassed/invisible during normal operation, only intercepts (and only charges) during a detected incident (rate-limit storm, outage, deprecation).

3. **Target-state routing**
   - Stimulus: a thermostat — doesn't choose the temperature, just closes the gap between actual and desired.
   - Connection: current routing strategies (cost-based, latency-based, performance-based) are all rule-based ("if X then route to Y"); a thermostat routes continuously toward a stated goal instead.
   - Idea: customer states an outcome (e.g. "p95 < 400ms, cost < $Y/mo") instead of a routing rule; gateway continuously renegotiates provider mix to hold that target proactively, not reactively.

4. **Collective fatigue-aware routing**
   - Stimulus: migratory birds — no single leader; formation changes who's at the front based on fatigue.
   - Connection: no router coordinates load *across customers* to protect provider health — each customer's routing is optimized selfishly, in isolation.
   - Idea: share anonymized provider-fatigue/rate-limit signals across the whole customer base so routing shifts away from a strained provider before anyone hits a 429 (network-effect moat via shared data, not per-tenant config).

5. **Semantic-fidelity prompt translation**
   - Stimulus: a translator at the UN — converts meaning in real time without altering intent, invisible when done well.
   - Connection: routers today sell structural/API normalization (unified schema) but not semantic normalization; different models interpret the same instructions differently.
   - Idea: a layer that adapts prompts per-model to preserve *intended behavior*, not just API shape — e.g. restructuring a system prompt so a model weak at instruction-following still behaves as intended.

(Two stimuli did not produce kept ideas: a vending machine — full self-serve transaction but fixed catalog — just redescribed what a router already is, so it was abandoned. A rehearsal conductor — catches the one player out of sync — produced a related but distinct idea, ensemble-divergence debugging, noted separately from the five above.)

## Meta-pattern identified

All five ideas treat the provider relationship as adversarial/uncertain (provider might fail, degrade, run out) rather than cooperative/known (which is how existing routers' feature sets — routing, catalog, dashboards — are built). **Nobody in the AI-router space sells "provider risk management" as its own product category** — it's currently only handled ad hoc via basic fallback.
