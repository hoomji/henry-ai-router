# AI gateway competitive landscape: what incumbents sell for provider risk

    Source: https://openrouter.ai/docs/features/provider-routing — OpenRouter Provider Routing (plus per-vendor sources cited inline throughout)
    Retrieved: 2026-08-15

Resolves [hoomji/henry-ai-router#3](https://github.com/hoomji/henry-ai-router/issues/3).
Consumers: the provider-risk gateway product exploration (`IDEA.md` ideas 1–4) and
grilling tickets #6/#7/#8. Note: the ticket referenced
`docs/product-specs/provider-risk-management-gateway.md`, which does not exist in the
repository at the time of writing; the candidate behaviors evaluated here are the ones
recorded in `IDEA.md` (usage-decay pricing, incident-only routing/pricing, target-state
routing, collective fatigue-aware routing).

All facts below were accessed **2026-08-15**. Sourced facts carry a vendor URL; anything
without a URL is repository inference and is marked as such.

## Decision question and answer

**Is "provider risk management as a product" — especially incident-only pricing —
genuinely unclaimed ground, and which spec behaviors are already table stakes?**

**Incident-only pricing is verified-absent across the entire surveyed field.** All nine
products were checked specifically for pricing conditional on failures or incidents.
Every published pricing model is always-on: a percentage skim on money-in (OpenRouter
5.5% on Stripe credits; Cloudflare Unified Billing 5%), a flat subscription metered on
request/log volume (Portkey $49+, Helicone $79+, Unify $75), an enterprise license
(LiteLLM, Kong), token passthrough (Martian), or plain per-token rates (Bedrock — whose
cross-region resilience is free and whose Global profile is ~10% *cheaper*). No vendor
charges only when a failover fires. Two caveats (inference): (1) no incumbent has
*validated* the model either — unclaimed is not the same as proven; (2) Martian/Thesean
sell enterprise contracts with no public rate card, so a private incident-conditional
term cannot be ruled out from desk research.

**Cross-customer provider-health signals are almost unclaimed.** Only two players have
aggregated multi-tenant health data at all: OpenRouter (feeds its own routing; public
per-provider uptime/TTFT/throughput stats) and Helicone (a public status board computed
"from millions of real, anonymized production requests" — but its docs never say that
fleet-wide signal feeds routing, which is documented as reactive and cost-first). Unify,
which historically owned the shared live-benchmark position, has pivoted away and
unpublished the asset. Kong explicitly does not synchronize health even between one
customer's own gateway nodes. Nobody sells the shared strain signal itself or
coordinates load across customers to pre-empt 429s.

### Spec-behavior verdicts (IDEA.md ideas vs the field)

| Candidate behavior (IDEA.md) | Verdict | Nearest incumbent art |
|---|---|---|
| Automatic failover/fallback | **Table stakes** | Ships everywhere except Bedrock (regions-only) and Martian (not documented); OpenRouter has it on by default |
| Latency-/cost-aware routing | **Table stakes** | OpenRouter `sort`, LiteLLM named strategies, Kong EWMA/cost balancing, Helicone cheapest-first |
| Incident-only routing (bypassed by default, intercepts only during incidents) | **Unclaimed** | Every gateway is an always-on middleman; no bypass-by-default architecture exists |
| Incident-only pricing | **Unclaimed (verified negative at all nine)** | Nothing adjacent: Helicone's PTB→BYOK fallback changes who pays, not the rate; Thesean's Quality SLA is vendor-side risk, not a conditional customer charge |
| Usage-decay pricing (pricing idle reserved capacity) | **Unclaimed** | Bedrock Provisioned Throughput bills reserved capacity flat, never decay-priced; no router prices holding |
| Target-state routing ("hold p95 < 400ms under $Y/mo") | **Mostly unclaimed** | Closest: OpenRouter `preferred_max_latency`/`preferred_min_throughput` filters and Cloudflare budget-cap nodes — static constraints, none continuously renegotiate a provider mix toward a stated target |
| Collective fatigue-aware routing (cross-customer strain signals) | **Partially claimed** | OpenRouter consumes pooled health internally; Helicone publishes it but does not route on it; the signal itself is not sold anywhere |

Sharpest positioning facts: OpenRouter's uptime-aware load balancing is *disabled* the
moment a customer sets `sort` or `order` — resilience and cost/latency optimization do
not compose there. Kong's docs concede per-node health isolation. Cloudflare ships no
latency- or cost-optimal routing at all, only budget caps. Portkey ships no automatic
performance- or price-based routing — all load-balancer weights are hand-set statics.

---

## Per-vendor findings

### OpenRouter

- **(a) Failover:** On by default. `allow_fallbacks` defaults `true`; "By default,
  requests are load balanced across the top providers to maximize uptime." Ordered
  `order` provider list and a cross-model `models` fallback array. Setting `sort` or
  `order` disables load balancing (and with it uptime-aware routing).
  https://openrouter.ai/docs/features/provider-routing (2026-08-15)
- **(b) Latency/cost routing:** `sort: "price" | "throughput" | "latency"`; `:nitro`
  and `:floor` model-slug shortcuts; the default load balancer weights providers by
  inverse square of price; `preferred_min_throughput` / `preferred_max_latency` filter
  on p50–p99 metrics over rolling 5-minute windows. Same URL (2026-08-15).
- **(c) Health signals — cross-customer:** Default routing prefers providers "that
  have not seen significant outages in the last 30 seconds" (provider-routing doc);
  OpenRouter tracks response times, error rates, and availability in real time and
  reroutes to healthy providers
  (https://openrouter.ai/docs/features/uptime-optimization, 2026-08-15).
  Provider-facing thresholds: uptime ≥95% routes normally, 80–94% deprioritized, <80%
  fallback-only; minimum 100 requests before uptime is computed; public per-model
  TTFT/throughput stats from real traffic
  (https://openrouter.ai/docs/guides/get-started/for-providers, 2026-08-15).
  Inference: the public-stats surface strongly implies platform-wide pooling, but no
  doc sentence literally says "aggregated across all customers."
- **(d) Pricing — always-on percentage on money-in:** 5.5% ($0.80 min) on Stripe
  credit purchases, 5% crypto; no inference markup; BYOK free to $25k/mo (PAYG) or
  $200k/mo (enterprise), then a 5% fee. https://openrouter.ai/docs/faq (2026-08-15).
  **Incident-only: no** — the fee is charged at credit top-up regardless of incidents.

### LiteLLM

- **(a) Failover:** Exists, opt-in ("Fallbacks are not enabled by default"):
  `fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`,
  `default_fallbacks`; configurable retries with exponential backoff.
  https://docs.litellm.ai/docs/proxy/reliability (2026-08-15; doc references v1.85.0 —
  drift-prone).
- **(b) Latency/cost routing:** Named strategies: `simple-shuffle` (default and
  recommended), `latency-based-routing`, `usage-based-routing-v2`, `least-busy`,
  `cost-based-routing`, plus custom via `CustomRoutingStrategyBase`. Cost/latency
  strategies are not the default. https://docs.litellm.ai/docs/routing (2026-08-15).
- **(c) Health signals — per-instance only:** Cooldowns (default 5s via
  `allowed_fails`/`cooldown_time`; 429 and >50%-failure triggers) and health endpoints
  with background checks (default 300s) operate per deployment
  (https://docs.litellm.ai/docs/routing, https://docs.litellm.ai/docs/proxy/health,
  2026-08-15). Self-hosted software: no cross-customer signal exists or can exist.
- **(d) Pricing:** Open source "$0 Free forever" (https://www.litellm.ai/, 2026-08-15);
  enterprise is a custom annual license "sized to your annual gateway request capacity
  ... never per token," no public numbers (https://www.litellm.ai/enterprise,
  https://litellm.ai/pricing, 2026-08-15). **Incident-only: no.**

### Portkey

Doc-host note: `docs.portkey.ai/docs/...` now 302-redirects to `portkey.ai/docs/...`.

- **(a) Failover:** Opt-in config object: `strategy.mode: "fallback"` with ordered
  targets; default trigger is any non-2xx, narrowable via `on_status_codes` (e.g. 429,
  503); targets fully nestable with load balancing and conditional routing.
  https://portkey.ai/docs/product/ai-gateway/fallbacks (2026-08-15).
- **(b) Latency/cost routing: effectively none.** Load-balancer weights are manual and
  static (operator-set, normalized; optional sticky sessions); no automatic weighting
  by performance, latency, or price
  (https://portkey.ai/docs/product/ai-gateway/load-balancing, 2026-08-15). Conditional
  routing evaluates metadata/params rules only — no latency or cost signals
  (https://portkey.ai/docs/product/ai-gateway/conditional-routing, 2026-08-15).
- **(c) Health signals — per-tenant, reactive:** Circuit breakers open on
  error-rate/timeout thresholds within your own config; no published provider stats,
  no cross-customer surface. Same docs (2026-08-15).
- **(d) Pricing:** Open source free/unlimited; Developer free (10k logs/mo);
  Production $49/mo for 100k logs then $9/mo per additional 100k up to 3M; Enterprise
  custom (10M+ logs). https://portkey.ai/pricing (2026-08-15). Flat fee plus
  log-volume overage accruing on every successful request. **Incident-only: no.**

### Martian / Thesean

- **Pivoted.** withmartian.com (2026-08-15) now presents Martian as an
  interpretability research lab; the commercial "best execution" product moved to the
  incubated entity **Thesean AI**, selling **Ship** (Beta, announced 2026-07-21:
  https://www.thesean.ai/blog/introducing-ship). The old router host
  `route.withmartian.com` fails TLS handshake entirely (2026-08-15) — consistent with
  decommissioning.
- **(a) Failover: not documented.** https://docs.withmartian.com/gateway (2026-08-15)
  describes unified access to 200+ models via OpenAI/Anthropic-compatible APIs with a
  usage dashboard, but no fallback-chain syntax, failover triggers, or provider
  priorities. Ship routes for optimization, not availability.
- **(b) Cost-aware: yes — the entire pitch.** Ship claims "the same capabilities and
  behavior ... at a guaranteed 50% lower cost" via runtime "best execution" (model,
  cascade, or ensemble per request), with capability- and behavioral-equivalence
  claims and a Quality SLA (https://www.thesean.ai/blog/introducing-ship, 2026-08-15).
  Latency-aware routing: not claimed anywhere reached.
- **(c) Health signals: none found**, per-tenant or aggregated (2026-08-15).
- **(d) Pricing:** Gateway is credit-based token passthrough; "Prices are fetched
  directly from the Martian Gateway API and updated every 5 minutes"
  (https://docs.withmartian.com/api-reference/models, 2026-08-15).
  `withmartian.com/pricing` and `thesean.ai/pricing` both 404 (2026-08-15); Ship is
  enterprise-contracted as a discount-plus-Quality-SLA. **Incident-only: none public**;
  confidence moderate only, since enterprise terms are private. Thesean's SLA is
  vendor-side quality risk, not a customer charge conditioned on incidents.

### Unify

- **Fully pivoted away from routing.** unify.ai (2026-08-15) sells "AI agent
  teammates" automating business tasks; the docs index (https://docs.unify.ai/llms.txt,
  2026-08-15) contains zero pages on routing, benchmarks, providers, or fallbacks. The
  historical quality/cost/latency router and its **aggregated live-benchmark data —
  formerly the closest thing in the field to a shared cross-customer provider-health
  product — are unpublished and gone.** No deprecation post exists; third-party pages
  still describing the router are stale caches. (Do not confuse unify.ai with
  unifygtm.com, a different company.)
- **(a)/(b):** No customer-facing failover or routing API today; the landing page's
  "fastest, cheapest and most performant" model selection is internal plumbing for
  their agents (https://unify.ai, 2026-08-15).
- **(d) Pricing:** Team $75/mo including 30,000 credits (no per-seat), start at $0,
  Enterprise custom (https://unify.ai/pricing, 2026-08-15). **Incident-only: no.**

### Helicone

Corporate drift flag: helicone.ai carries a "Helicone Joins Mintlify" banner
(2026-08-15) — expect docs-URL and pricing churn.

- **(a) Failover: yes, default-on for the cloud gateway.** The gateway "automatically
  routes your requests to the best available provider, with instant failover when
  things go wrong"; priority is your BYOK keys first, then Helicone managed keys.
  Fallback chains are encoded in the model string (e.g.
  `"gpt-4o-mini/azure,gpt-4o-mini/openai,gpt-4o-mini"`; `/provider` pins;
  `!provider` excludes). Failover triggers: 429, 401, 400 (context length), 408,
  500+. Opt-in retries with exponential backoff via `Helicone-Retry-Enabled: true`.
  https://docs.helicone.ai/gateway/provider-routing (2026-08-15). (The former
  `/gateway/fallbacks` URL is 404 — consolidated into provider-routing.)
- **(b) Cost-aware: yes, default** — "Routes to the cheapest provider first.
  Equal-cost providers are load balanced" (same URL, 2026-08-15). Latency-aware
  routing is **not** in the cloud-gateway docs; the self-hosted OSS gateway repo
  separately describes latency-based P2C + PeakEWMA health/rate-limit-aware balancing
  (https://github.com/Helicone/ai-gateway, 2026-08-15) — treat the two surfaces as
  distinct.
- **(c) Health signals — genuinely cross-customer, but not wired to routing.**
  Public live status board at https://www.helicone.ai/status (2026-08-15,
  JS-rendered): metrics "calculated from millions of real, anonymized production
  requests" drawn from "billions of LLM interactions from tens of thousands of
  users," explicitly contrasted with synthetic status-page health checks. Columns per
  provider: status, avg latency/token (24h), 500-error rate (10 min / 24h).
  Caveat (inference): nothing in the routing docs says this fleet-wide signal feeds
  routing decisions predictively — documented failover is reactive to your own
  request's errors and selection is cost-first. The signal exists; the product
  coupling does not.
- **(d) Pricing:** Hobby free (10k requests, 1 GB), Pro $79/mo, Team $799/mo,
  Enterprise custom, usage-based overages (https://helicone.ai/pricing, 2026-08-15);
  gateway credits advertised at 0% token markup, explicitly benchmarked against
  OpenRouter's 5.5% (https://docs.helicone.ai/gateway/overview.md, 2026-08-15). The
  0%-markup vs "usage-based pricing applies" tension is unreconciled in public docs —
  the per-request usage rate is unpublished. **Incident-only: no.** The PTB→BYOK
  billing fallback changes which funding source pays under failure, not the rate.

### Cloudflare AI Gateway

- **(a) Failover:** Ordered fallback array on the Universal endpoint (triggered by
  errors/timeouts; `cf-aig-step` response header reports which step served), plus
  gateway-level automatic retries (max 5 attempts, ≤5s delay,
  constant/linear/exponential backoff) shipped 2026-04-02.
  https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/ (page "Last
  updated Apr 20, 2026"),
  https://developers.cloudflare.com/ai-gateway/configuration/request-handling/
  (Jun 15, 2026),
  https://developers.cloudflare.com/changelog/post/2026-04-02-auto-retry-upstream-failures/
  (all 2026-08-15). Drift flag: the Universal endpoint is marked deprecated in the
  nav while the fallbacks doc still teaches it — Cloudflare is mid-migration to
  Dynamic Routing.
- **(b) Latency/cost routing:** Dynamic Routing (page updated Aug 7, 2026) is a
  visual/JSON flow builder: conditional, percentage-split, rate-limit, and
  budget-limit nodes with model fallbacks. Cost-*budget*-aware, not cost-optimal; no
  latency- or health-based node exists.
  https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/ (2026-08-15).
- **(c) Health signals: none documented.** No provider status surface, no health
  checks per-tenant or shared; failover is reactive to your own request's error
  (https://developers.cloudflare.com/ai-gateway/features/, 2026-08-15).
- **(d) Pricing:** Core features free (analytics, caching, rate limiting; fallbacks,
  retries, and dynamic routing are not paywalled in the pricing doc). Log storage by
  Workers plan (Free: 100k logs/account; Paid: 10M logs/gateway); Logpush on Workers
  Paid only, 10M/mo then $0.05/M; Unified Billing charges 5% on credit purchases.
  https://developers.cloudflare.com/ai-gateway/reference/pricing/ (May 19, 2026) and
  https://developers.cloudflare.com/ai-gateway/reference/limits/ (2026-08-15).
  **Incident-only: no.**

### Kong AI Gateway (`ai-proxy-advanced`)

Doc-host note: `docs.konghq.com/hub/kong-inc/...` 301-redirects to
`developer.konghq.com/plugins/...`.

- **(a) Failover:** Balancer `retries` default 5; `failover_criteria` defaults
  `["error","timeout"]` — client errors don't trigger failover unless widened;
  circuit breaker via `max_fails` (default 0 = off) + `fail_timeout` (10s) in Gateway
  3.13+; cross-provider failover across mixed formats in 3.10+; the `priority`
  algorithm gives tiered failover across model groups.
  https://developer.konghq.com/plugins/ai-proxy-advanced/ and .../reference/
  (2026-08-15; behavior gated by 3.8/3.10/3.13 version boundaries — drift-prone).
- **(b) Latency/cost routing — strongest algorithm set in the field:** seven
  algorithms including lowest-latency (peak EWMA; `latency_strategy` default `tpot`,
  alt `e2e`), lowest-usage (`tokens_count_strategy` options include `cost`), and
  semantic routing (requires Redis Stack vector DB plus an embeddings provider). Same
  URLs plus https://developer.konghq.com/how-to/use-semantic-load-balancing/
  (2026-08-15).
- **(c) Health signals — per-node:** Active + passive health checks exist, but "There
  is no cluster-wide synchronization of health information, so each Kong Gateway node
  determines the health of its Targets separately"
  (https://developer.konghq.com/gateway/traffic-control/health-checks-circuit-breakers/,
  2026-08-15). Health is not shared even within one customer's fleet, let alone
  across customers.
- **(d) Pricing:** Plugin tier `ai_gateway_enterprise`, requires Kong Gateway 3.8+;
  the free/OSS path is the plain `ai-proxy`. Konnect marketing page (medium
  confidence; figures not mirrored in docs): free trial, Plus per-gateway monthly
  with 5 LLM models included (+~$100/mo per additional model), Enterprise custom.
  https://developer.konghq.com/plugins/ai-proxy-advanced/ and
  https://konghq.com/pricing (2026-08-15). **Incident-only: no.**

### AWS Bedrock cross-Region inference (CRIS)

- **(a) Failover:** Automatic, opaque region selection within a geography
  (Geographic profile) or worldwide (Global profile): "Amazon Bedrock automatically
  selects a commercial AWS Region ... to process your inference request."
  Regions-only, single model family — no cross-provider or cross-model fallback.
  https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
  (2026-08-15).
- **(b) Routing criteria: not disclosed.** No latency/cost/health criterion is
  published; no weighting or pinning; after-the-fact observability only via
  CloudTrail `additionalEventData.inferenceRegion`. Same URL (2026-08-15).
- **(c) Health signals:** AWS capacity awareness is inherently cross-customer (its
  own fleet) but entirely internal — zero customer-facing health signal or API.
  Inference: the only cross-customer health mechanism in the field besides
  OpenRouter's and Helicone's, and it is invisible.
- **(d) Pricing:** "There's no additional routing cost for using cross-Region
  inference. The price is calculated based on the Region from which you call an
  inference profile" (same URL); Global CRIS saves "approximately 10% on both input
  and output token pricing" vs geographic
  (https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html,
  2026-08-15). The resilience feature is free-to-discounted, never surcharged.
  **Incident-only: no.** For usage-decay pricing: Provisioned Throughput (flat
  reserved-capacity billing; not supported with inference profiles) is the nearest
  art to reserved capacity and has no decay/reclaim pricing.

---

## Drift watchlist (re-verify before external use)

- OpenRouter: 5.5% Stripe fee, BYOK caps ($25k/$200k), 95%/80% uptime thresholds,
  `preferred_min_throughput`/`preferred_max_latency` (new-looking params).
- LiteLLM: strategy list and cooldown defaults (doc pinned to v1.85.0; rapid releases).
- Portkey: doc-host migration and the $49 / $9-per-100k figures.
- Helicone: Mintlify acquisition may move docs URLs; status-page figures are live;
  `/gateway/fallbacks`, `/gateway/credits`, `/gateway/pass-through-billing` already 404.
- Cloudflare: Universal-endpoint deprecation vs Dynamic Routing migration (Dynamic
  Routing page updated 2026-08-07).
- Kong: version-gated behavior (3.8/3.10/3.13) and Konnect pricing-page figures.
- Martian/Thesean: mid-repivot; Ship is a month-old Beta; gateway model prices refresh
  every 5 minutes by API.
- Unify: pivot is recent and unannounced — never trust search snippets for this
  vendor; re-verify unify.ai directly.
- Bedrock: per-model CRIS rate columns on https://aws.amazon.com/bedrock/pricing/
  (JS-heavy page; per-model deltas unverified beyond the ~10% Global figure).
