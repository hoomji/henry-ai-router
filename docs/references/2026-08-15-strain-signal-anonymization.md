# Anonymized cross-customer strain signals without traffic leakage

Source: multiple (each section carries its own `Source:` line) — prior-art survey for issue #5
Retrieved: 2026-08-15

Research for hoomji/henry-ai-router#5: what prior art exists for publishing aggregated
provider-health/strain signals across a customer base such that no single customer's
traffic pattern is inferable, and what aggregation contract the provider-risk gateway
spec should require (spec behavior 3, anonymization boundary).

Repository consumer: the provider-risk gateway spec (issue #2 map; behavior 3 —
cross-customer strain signals).

Sourced facts are attributed inline; the "Recommended aggregation contract" section is
repository inference, not a claim any source makes.

---

## 1. CDN / DNS shared health checks

Source: https://blog.cloudflare.com/detecting-internet-outages/ — Gone offline: how Cloudflare Radar detects Internet outages
Source: https://developers.cloudflare.com/load-balancing/monitors/ — Cloudflare Load Balancing Monitors
Source: https://blog.cloudflare.com/load-balancing-monitor-groups-multi-service-health-checks-for-resilient/ — Load Balancing Monitor Groups
Retrieved: 2026-08-15

- Cloudflare Radar detects Internet disruptions by fusing multiple independent signal
  classes it already observes as an operator — DNS query volume, HTTP request volume,
  NetFlows, and Network Error Logging (NEL) reports — and marks an anomaly "false
  positive" if it cannot be confirmed across multiple data sources. Key pattern:
  **corroboration across independent signal sources before publishing**, which also
  means no single tenant's traffic can create a published event.
- Cloudflare Load Balancing health monitors probe from three separate data centers per
  region and declare a region healthy on majority vote — **quorum over probes, not raw
  per-observer data**, is what is shared onward.
- The published Radar Outage Center exposes only macro/aggregate views (per network/ASN,
  per country), never per-customer traffic.

## 2. Crowd-sourced outage aggregation (Downdetector-style)

Source: https://grokipedia.com/page/Downdetector — Downdetector (methodology summary)
Source: https://martinuke0.github.io/posts/2026-03-25-how-downdetector-works-the-crowdsourced-power-behind-real-time-outage-detection/ — How DownDetector Works
Retrieved: 2026-08-15

- Downdetector aggregates tens of millions of user problem reports per month across
  25,000+ services. It maintains a **rolling per-service, per-time-of-day baseline** and
  publishes an incident only when current report volume exceeds a dynamic threshold
  (roughly a three-sigma deviation from baseline).
- Individual reports are never published; only the deviation-from-baseline curve and a
  coarse incident state are. Geolocation is aggregated to region heatmaps.
- Key patterns for the gateway spec: **publish deviations from baseline, not absolute
  volumes** (absolute request counts are the thing that identifies a tenant), and
  **suppress output entirely below a report-count threshold**.

## 3. Browser telemetry precedents (NEL, CrUX, RAPPOR, k-anonymity thresholds)

Source: https://www.w3.org/TR/network-error-logging/ — W3C Network Error Logging
Retrieved: 2026-08-15

- NEL's privacy design principle: a report may only contain information the receiving
  server already had access to when serving the request ("server-confined reporting").
  Analogue for the gateway: a shared strain feed should only carry facts the *provider*
  side of the connection already exposes (status codes, latency), never
  customer-identifying context (prompts, key IDs, per-tenant volumes).

Source: https://developer.chrome.com/docs/crux/methodology — CrUX methodology
Retrieved: 2026-08-15

- Chrome UX Report only includes an origin if it is "sufficiently popular" — a minimum
  visitor count across pages; below the threshold the origin is simply absent from the
  dataset. **Suppression, not noise, is the first line of defense** for small cohorts.

Source: https://research.google.com/pubs/archive/42852.pdf — RAPPOR: Randomized Aggregatable Privacy-Preserving Ordinal Response
Retrieved: 2026-08-15

- RAPPOR (Google Chrome telemetry) adds local randomized-response noise per client so
  the aggregator can recover population distributions but never a single client's true
  value. Relevant caution from the paper's cohort design: cohorts that are too small
  yield insufficient signal — local DP is heavyweight and mainly needed when the
  *aggregator itself* is untrusted. In the gateway's case the gateway already sees all
  traffic, so central aggregation with suppression + coarsening is the appropriate
  model; local DP is unnecessary.

Source: https://developers.google.com/privacy-sandbox/private-advertising/protected-audience-api/k-anonymity — Privacy Sandbox k-anonymity
Source: https://developers.google.com/ads-data-hub/guides/privacy-checks — Ads Data Hub privacy checks
Retrieved: 2026-08-15

- Deployed k-anonymity thresholds in production Google systems: Protected Audience
  started at k=10 (30-day window) moving to k=50 (1-hour update period); Ads Data Hub
  requires ~50 unique users per result row for general queries (with noise injection at
  ~20, and 10 for click/conversion-only data). General statistical-disclosure guidance
  ranges k = 3–30. Practical takeaway: **k in the 10–50 range is the industry norm**,
  with the low end acceptable when the published values are coarse and the high end
  used when adversaries can issue differencing queries.
- Ads Data Hub's "difference checks" matter: even with a per-row minimum, an adversary
  who can compare two overlapping aggregates (e.g. the feed at t and t+1, or with/
  without themselves) can difference out one member. Any contract needs **change-based
  suppression**, not just level-based.

## 4. AI-gateway vendors already publishing shared provider-health data

Source: https://openrouter.ai/docs/guides/best-practices/uptime-optimization — OpenRouter uptime optimization
Retrieved: 2026-08-15

- OpenRouter continuously tracks response times, error rates, and availability across
  all providers from live customer traffic, and publishes per-model/per-provider uptime
  charts: hourly buckets over 3 days, a 24-hour trend, and a 3-day aggregate
  availability percentage; the same data is available via their Endpoints API. The docs
  state **nothing about anonymization, cohort minimums, or customer isolation** — the
  published percentages are implicitly aggregate but there is no stated contract. This
  is the closest existing product to spec behavior 3, and its gap (no explicit
  anonymization boundary) is exactly what our spec should close.

Source: https://docs.helicone.ai/gateway/concepts/error-handling — Helicone gateway error handling
Retrieved: 2026-08-15

- Helicone's gateway reacts *within a customer's own deployment*: when a provider
  exceeds a 10% error rate or returns rate-limit errors it fails over. Health state is
  per-deployment, not a shared cross-customer feed. Portkey likewise exposes analytics
  (volume, latency, cost, error rates) per account only. Neither publishes a
  cross-customer strain network; OpenRouter is the only gateway found doing so, and
  independent observers (e.g. https://www.modeluptime.com/, retrieved 2026-08-15) fill
  the gap with synthetic probes rather than customer traffic.

---

## Recommended aggregation contract (repository inference)

The spec should require all of the following before any strain signal derived from
customer traffic is visible to any other customer:

1. **Minimum cohort size: k >= 10 distinct customers** contributing traffic to a
   (provider, model-family, signal, time-bucket) cell, and **k >= 20 for any cell a
   customer can query while also contributing to it** (so self-subtraction still leaves
   >= 10 others, addressing the Ads Data Hub differencing concern). Cells below
   threshold are suppressed (absent), CrUX-style — not zero-filled, not noised.
2. **Time bucketing: 5-minute minimum bucket for the live feed, published with one full
   bucket of delay; 1-hour buckets for history.** Sub-minute or event-level publication
   would let a customer correlate feed flickers with their own request timing and
   identify other tenants' bursts. OpenRouter's hourly/3-day granularity shows hourly is
   sufficient for routing decisions; 5 minutes is the aggressive-but-safe floor for
   failover use.
3. **Safe signal types (rates and coarse quantiles only, never counts):**
   - 429/rate-limit rate: safe as a *fraction of cohort requests*, quantized (e.g. to
     5% steps or banded none/elevated/severe).
   - 5xx/error rate: same treatment, safe.
   - Latency shift: safe as a *relative* indicator (e.g. p50/p95 vs. that provider's
     own trailing 24h baseline, banded normal/elevated/degraded), Downdetector-style
     deviation-from-baseline rather than absolute values.
4. **What must never appear in the shared feed (leakage vectors):**
   - Absolute request counts, token volumes, or contributor counts per cell — these are
     the direct fingerprint of a large tenant's traffic pattern.
   - Any per-customer dimension (org, key, region-of-customer) or any cell keyed finer
     than provider x model-family.
   - Unquantized rates over small cohorts — with k=10, a raw 429-rate with many decimal
     places is effectively a count.
   - Event-time precision: publishing the exact minute a strain event began, when one
     tenant caused it, timestamps that tenant's burst for everyone else.
   - Feed deltas that flip when one contributor joins/leaves a cell: require that a
     published value change only if it would also have changed with any single
     contributor removed (change-based suppression), or noise the quantization boundary.
5. **Server-confined principle (from NEL):** the feed may only carry facts the provider
   side already observes (status codes, latencies); never request content, metadata, or
   anything derived from a single customer's payloads.
6. **Corroboration before incident state (from Cloudflare Radar / Downdetector):** an
   explicit "provider degraded" flag, if published, requires the underlying banded
   signals to agree across >= 2 independent signal types or >= 2 disjoint customer
   cohorts; otherwise publish only the banded signals and let clients decide.

Net effect: the network signal customers actually need for routing — "is this provider
under strain right now, and how badly" — survives quantization, banding, and 5-minute
delay intact, while every published value is a coarse rate over >= 10 tenants from
which no individual traffic pattern can be reconstructed.
