# Provider capability floors: what providers actually publish

    Source: multiple (each section carries its own `Source:` line) — first-party provider docs, SLAs, and live public catalogue APIs
    Retrieved: 2026-08-15

Research for [hoomji/henry-ai-router#11](https://github.com/hoomji/henry-ai-router/issues/11):
do hosted model providers publish latency, cost, or availability characteristics durable
enough to serve as the **declared capability floor** that behavior 1's declaration-time
feasibility check compares a customer target against?

Repository consumers: the provider-risk gateway product spec (behavior 1, target-state
routing, `infeasible_by_declaration`); [`docs/adr/0001-declaration-time-vs-observed-infeasibility.md`](../adr/0001-declaration-time-vs-observed-infeasibility.md);
`providers/capabilities.ts` in [`docs/design-docs/gateway-design.md`](../design-docs/gateway-design.md).

Sourced facts carry a URL. The "Verdict" and "What this means for #6" sections are
repository inference and are marked as such.

---

## Decision question and answer

**Can the gateway hold a per-model capability floor honest enough to reject a customer's
target at write time with a 422?**

**For cost: yes.** Every surveyed provider publishes per-model, per-token rates, and two
public catalogue APIs republish them in machine-readable form with no authentication.
The caveat is that a *single* `cost_per_1k_tokens_usd` rate per model is wrong — real
rates are a function of (input vs output, context-length tier, cache read vs write, batch
vs interactive, service tier, inference geography), and the published spread within one
model is larger than the spread between some models.

**For latency: no provider publishes one.** Not one of OpenAI, Anthropic, Google, AWS, or
Azure publishes a per-model latency number in any form — no docs table, no SLA, no status
page. Microsoft comes closest and gets as far as "we recommend GPT-4o mini" plus a formula
you populate from your own telemetry. Every numeric per-model latency figure available
anywhere is **measured by a third party**, not declared by the provider.

**For availability: partially, at the wrong granularity.** Published availability
commitments exist (AWS Bedrock 99.9%, Anthropic Priority Tier "targets 99.5%", Azure
99.9%) but they are scoped per *region and account*, or per *purchased capacity tier* —
never per model. Provider status pages are per API surface (`Responses`, `Batch`,
`Embeddings`), not per model, and publish no uptime percentage at all.

**The load-bearing consequence** (inference): a floor keyed on `model` is the wrong key.
Live measurement shows the same model served through three hosts differs by **86% in p50
latency** (Claude Sonnet 4.5: 744 ms via Vertex, 795 ms via Anthropic direct, 1383 ms via
Bedrock — see §4). A floor stored per model, compared against a customer's `p95_ms`
target, would reject feasible targets and accept infeasible ones depending on which host
the router picked. Declaration-time feasibility survives, but only if the floor is keyed
per **(model, host, region, service tier)** and sourced from measurement rather than from
provider publication.

---

## 1. First-party provider publication, per dimension

| Provider | Latency floor published? | Availability floor published? | Cost floor published? | Granularity of what *is* published |
|---|---|---|---|---|
| OpenAI | No numeric per-model figure. Fast mode (ex-Priority) carries a p50 latency SLA for enterprise agreements only, with no public number | No public per-model uptime; Scale Tier states a 99.9% uptime SLA | Yes, per model, per token, per tier | Per API surface (status page), per account tier (SLA) |
| Anthropic | No | Priority Tier "targets 99.5% uptime" — a target, on a tier no longer purchasable | Yes, per model, per token, with published multipliers | Per tier and per model version (commitments), never per model publicly |
| Google Vertex AI | No | SLA per service, not per model | Yes, per model, per token | Per model for *throughput* (tokens/sec per GSU) — the one first-party per-model performance number found |
| AWS Bedrock | No | 99.9% per region, per account; Reserved tier "targets 99.5% uptime for model response" | Yes, per model, per token, per tier | Per region, per account, per tier |
| Azure OpenAI | No numeric value; a formula and a qualitative model recommendation | 99.9% availability SLA; a 99% *latency* SLA exists for provisioned deployments, with no published millisecond target | Yes, per model, per token, per region | Per deployment type; latency left to the customer's own Azure Monitor metrics |

### OpenAI

    Source: https://status.openai.com/api/v2/summary.json — OpenAI status page component API (queried directly)
    Source: https://openai.com/api-fast-mode/, https://help.openai.com/en/articles/11647665-priority-processing-faq — Fast mode / Priority processing (403 to automated fetch; content below is from indexed search results, treat as secondary)
    Retrieved: 2026-08-15

- The status page exposes **25 components**, every one of them an API surface —
  `Responses`, `Images`, `Audio`, `Batch`, `Embeddings`, `Fine-tuning`, `Realtime`,
  `Moderations`, `Search`, `Sora`, `Files`, and so on. **Zero components are per model**,
  and the summary payload carries **no uptime percentage field**. A per-model availability
  floor cannot be derived from it, and neither can a per-model outage history.
- Priority processing was renamed **Fast mode** on 2026-07-30; either `service_tier:
  "priority"` or `"fast"` is accepted. Latency SLAs are stated as **p50 request latency on
  a per-5-minute basis** (per-minute for older enterprise agreements), with service
  credits when missed. The **numeric target is not public** — it exists inside enterprise
  agreements. Scale Tier carries a 99.9% uptime SLA and, since July 2026, spills over to
  Fast mode. Flex Tier is ~50% cheaper, best-effort, and may queue or fail under load.
  *(Secondary; openai.com and platform.openai.com both return 403 to automated fetch, so
  these figures were not verified against the page itself.)*

Inference: OpenAI's own latency commitment is p50, private, and per-account — the
opposite shape from a public per-model p95 floor. Anyone claiming a published OpenAI
latency floor is quoting a measurement, not OpenAI.

### Anthropic

    Source: https://platform.claude.com/docs/en/api/service-tiers — Claude Platform, Service tiers
    Retrieved: 2026-08-15

- Three tiers: Priority, Standard, Batch. **"Priority Tier targets 99.5% uptime with
  prioritized computational resources."** That is the only numeric performance commitment
  on the page — no latency, no TTFT, no tokens-per-second figure appears anywhere.
- The page opens with: **"Priority Tier capacity commitments are no longer available for
  purchase."** A capability floor sourced from a purchasable tier commitment can be
  withdrawn between one read and the next; this one was.
- A commitment is scoped to **a specific model version**, input and output tokens per
  minute, and a duration (1/3/6/12 months) — i.e. the floor that does exist is per
  *contract*, not per model, and is unavailable to a gateway reading public docs.
- Priority Tier excludes Claude Mythos 5, Claude Mythos Preview, Claude Opus 5, and
  Claude Sonnet 5 — the newest models are the ones with no commitment at all.
- Published capacity burndown multipliers (relevant to §3): cache reads count **0.1
  tokens per token**; cache writes **1.25** (5-minute TTL) or **2.00** (1-hour TTL);
  US-only inference (`inference_geo: "us"`) on Claude 4.6+ counts **1.1** for both input
  and output. The docs state these "reflect the relative pricing of each token type."

### Google Vertex AI

    Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/measure-provisioned-throughput — Calculate Provisioned Throughput requirements (page served navigation-only to automated fetch; figure below is from the indexed search result, secondary)
    Retrieved: 2026-08-15

- Provisioned Throughput is sold in **Generative AI Scale Units (GSUs)**, and throughput
  per GSU is **published per model** — e.g. 1 GSU of `gemini-2.5-flash` yields "an average
  of 2,690 tokens per second of continuous throughput." This is the only **first-party
  per-model performance number** found in the whole survey.
- It is a *throughput* figure for reserved capacity, not a latency figure, and it does not
  translate into a p95 for an individual request. Vertex's SLA covers availability
  (commonly cited at 99.5%/99.9% depending on term); no latency SLA was found.

Inference: the closest thing to a published per-model floor in the industry is a
tokens-per-second capacity number for customers who pre-purchase capacity. It answers
"how much can I push", not "how fast is one call" — which is the question `p95_ms` asks.

### AWS Bedrock

    Source: https://aws.amazon.com/bedrock/sla/ — Amazon Bedrock Service Level Agreement
    Source: https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html — Service tiers for optimizing performance and cost
    Retrieved: 2026-08-15

- The SLA commits to a Monthly Uptime Percentage **for each AWS region**, applied
  **separately to each account**. Availability is "the percentage of Requests processed by
  Amazon Bedrock that do not fail with Errors", where an Error is **any request returning
  a 500**, measured in **5-minute intervals**. Credits: 10% (99.0–99.9%), 25%
  (95.0–99.0%), 100% (below 95.0%). **No latency commitment of any kind.**
- Four service tiers: **Reserved, Priority, Standard, Flex**. The Reserved tier
  **"targets 99.5% uptime for model response"** (minimums: 100,000 input TPM / 10,000
  output TPM; 1- or 3-month terms; sales-gated). Priority "delivers the fastest response
  times for a price premium" — **no number**. Flex trades longer processing time for a
  discount — **no number**.
- Tier support **varies by model**: "go to Models at a glance and choose the model you are
  interested in to see which service tier that model supports."

Two facts matter for the floor's key. First, the availability commitment is **per region,
not per model** — a floor stored per model that is really a per-region promise is exactly
the failure mode the ticket names ("wrong in a way nobody will notice until a customer is
in the wrong region"). Second, `service_tier` is a **per-request parameter** (`reserved |
priority | default | flex`), and the resolved tier is returned in the response and in
CloudWatch as `ResolvedServiceTier` — so the same model, same region, same account has
**four different latency profiles depending on a request-time flag**, and the provider
publishes a number for none of them.

### Azure OpenAI / Microsoft Foundry

    Source: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency — Azure OpenAI performance & latency (doc dated 2026-05-14)
    Source: https://azure.microsoft.com/en-us/blog/announcing-the-availability-of-azure-openai-data-zones-and-latest-updates-from-azure-ai/ — Azure blog, latency SLA announcement
    Retrieved: 2026-08-15

- Microsoft publishes a **latency model, not latency values**: `TTLT = TTFT + (TBT ×
  Tokens Generated)`, and instructs the customer to populate it from their own Azure
  Monitor metrics (`AzureOpenAITTLTInMS`, `AzureOpenAITimeToResponse`,
  `AzureOpenAINormalizedTBTInMS`). The doc's own guidance on model choice is qualitative:
  "If model latency is important to you, we recommend trying out the GPT-4o mini model."
  **No per-model millisecond table exists on the page.**
- The doc names four drivers of per-call latency: "(1) the model, (2) the number of tokens
  in the prompt, (3) the number of tokens generated, and (4) the overall load on the
  deployment and system", and states that factors 1 and 3 "often contribute most".
  It also warns that content filtering adds latency and that **mixing workloads on one
  endpoint degrades latency**, because calls are batched together and short calls wait
  behind long completions.
- Microsoft does publish a **99% latency SLA for token generation** ("This latency SLA
  ensures that tokens are generated at faster and more consistent speeds, especially at
  high volumes"), available for **Provisioned-Managed deployments**; the announcement
  carries no per-model millisecond target. A 99.9% availability SLA covers the service
  generally. *(The 99.9% figure and the credit schedule are widely reported but the
  Microsoft SLA document itself was not fetchable; treat as secondary.)*
- Per-model *capacity* is published in PTU terms for sizing (e.g. GPT-4o mini: 800-token
  prompt / 150-token generation at 30 RPM ≈ 15 PTUs), and "the number of PTUs scales
  roughly linearly with call rate when the workload distribution remains constant."

Inference: Microsoft's doc is the strongest available argument *against* a static
per-model latency floor — it says outright that latency is a function of output token
count and deployment load, both of which are properties of the customer's workload rather
than of the model. A floor that ignores generation length compares against the wrong
quantity.

## 2. Is cost the easy case?

Mostly yes — the rates are published, machine-readable, and free of authentication — but
"a single per-1k rate" is not a thing any provider actually sells.

    Source: https://ai-gateway.vercel.sh/v1/models/anthropic/claude-sonnet-4.5/endpoints — Vercel AI Gateway endpoints API (queried directly, unauthenticated)
    Source: https://openrouter.ai/api/v1/models — OpenRouter models API (queried directly, unauthenticated)
    Retrieved: 2026-08-15

Live response for one model (Claude Sonnet 4.5, Anthropic-direct endpoint), USD per token:

| Field | Rate |
|---|---|
| `prompt` (≤200k context) | 0.000003 |
| `prompt` (>200k context) | 0.000006 |
| `completion` (≤200k) | 0.000015 |
| `completion` (>200k) | 0.0000225 |
| `input_cache_read` | 0.0000003 |

The same catalogue for Claude Opus 5 (Fast) via OpenRouter returns `prompt` 0.00001,
`completion` 0.00005, `input_cache_read` 0.000001, `input_cache_write` 0.0000125,
`input_cache_write_1h` 0.00002 — a **10× spread between the cheapest and most expensive
token type on a single model**.

What makes a single per-1k rate misleading, all of it published and therefore all of it
knowable at declaration time:

1. **Input vs output are different prices** (5× apart on Sonnet 4.5). A floor needs the
   customer's expected output ratio, which the target document does not currently carry.
2. **Context-length tiering.** Crossing 200,001 tokens doubles the input rate. Published
   as `prompt_tiers` / `completion_tiers` arrays; Vercel's SDK docs expose the same as
   `pricing.inputTiers`.
3. **Cache read vs cache write.** Reads are ~10× cheaper than base input; writes are more
   expensive than base input, and 1-hour-TTL writes more again. Anthropic's own burndown
   multipliers (0.1 read / 1.25 write / 2.00 1h-write) confirm the shape.
4. **Batch and service tiers.** Bedrock Flex is a discount tier, OpenAI Flex is ~50%
   cheaper, Fast mode is a premium; Anthropic's Batch tier is a separate price. The tier
   is chosen **per request**, so the cost floor is per (model, tier), not per model.
5. **Inference geography.** Anthropic's US-only inference (`inference_geo: "us"`) prices
   at **1.1×** on Claude 4.6+ models.

Inference: the cheapest *achievable* `cost_per_1k_tokens_usd` for a model is
well-defined and publishable — it is the all-cache-read, sub-tier-threshold, batch-tier
rate — but that floor is unachievable for any realistic workload, so comparing a customer
target against it would accept targets that can never hold. A useful cost floor must be
computed for a **stated workload shape** (input:output ratio, context band, tier), which
means the target document has to carry that shape or the check has to assume one and say
which.

## 3. Where per-model latency and availability numbers actually come from

Nobody's first-party docs. Three third parties measure and republish them; two do it over
an unauthenticated REST API.

### Vercel AI Gateway — the strongest available source

    Source: https://vercel.com/docs/ai-gateway/models-and-providers — Models & Providers (documents `GET /v1/models/{creator}/{model}/endpoints`)
    Source: https://ai-gateway.vercel.sh/v1/models/anthropic/claude-sonnet-4.5/endpoints — queried directly, unauthenticated
    Retrieved: 2026-08-15

The docs state that for models served by multiple providers, the endpoints route "returns
per-provider pricing, supported parameters, **uptime, throughput, and latency**." The live
response confirms it, per endpoint: `uptime_last_15m`, `uptime_last_1h`, `uptime_last_1d`,
`latency_last_1h` as `{p50, p95}` in milliseconds, and `throughput_last_1h` as `{p50,
p95}` in tokens/sec.

Snapshot, Claude Sonnet 4.5, 2026-08-15:

| Host | uptime 1d | latency p50 (ms) | latency p95 (ms) | throughput p50 (tok/s) |
|---|---|---|---|---|
| `anthropic` | 99.9786 | 795 | 855.5 | 47.5 |
| `bedrock` | 99.9739 | 1383 | 2053.6 | 55 |
| `vertexAnthropic` | 100 | 744.5 | 776.45 | 42.5 |

This single table answers the ticket's granularity question. **Same model, same day: p50
ranges 744.5 → 1383 ms (86% spread) and p95 ranges 776 → 2054 ms (165% spread) purely by
host.** A per-model floor is not merely imprecise here; a customer targeting `p95_ms:
900` is feasible on two of three hosts and infeasible on the third, and a per-model floor
must either pick the optimistic value (and accept impossible targets) or the pessimistic
one (and reject achievable ones).

### OpenRouter

    Source: https://openrouter.ai/api/v1/models/{id}/endpoints — queried directly, unauthenticated
    Source: https://openrouter.ai/docs/guides/best-practices/uptime-optimization — Uptime optimization
    Retrieved: 2026-08-15

- Per-endpoint fields returned: `uptime_last_5m`, `uptime_last_30m`, `uptime_last_1d`,
  plus `latency_last_30m` and `throughput_last_30m`. Uptime is populated and varies
  meaningfully per host — e.g. Claude Sonnet 4.5: Google 99.97%, Bedrock 99.93%,
  Anthropic 99.76%, a second Anthropic endpoint 97.94%; DeepSeek V3 via DeepInfra 93.66%
  vs Crusoe 99.98% on the same day.
- **`latency_last_30m` and `throughput_last_30m` returned `null` on every endpoint of
  every model sampled** (gpt-4o, claude-sonnet-4.5, gemini-2.5-flash,
  deepseek-chat-v3-0324) on the unauthenticated API. The fields exist in the schema; the
  values are not served publicly. The docs advertise programmatic access to "per-provider
  uptime data" specifically — latency is described as tracked, not as exposed.
- Prior repository finding, still standing (see
  [competitive landscape](2026-08-15-ai-gateway-competitive-landscape.md)): OpenRouter's
  `preferred_min_throughput` / `preferred_max_latency` filter on **p50–p99 metrics over
  rolling 5-minute windows**, i.e. the same numbers exist internally at a fine grain.

Inference: OpenRouter is a reliable public source for **availability** floors per (model,
host) and not a usable source for latency floors.

### Artificial Analysis

    Source: https://artificialanalysis.ai/methodology, https://artificialanalysis.ai/methodology/performance-benchmarking
    Retrieved: 2026-08-15

- Measures TTFT ("the time in seconds between sending a request... and receiving the
  first token"), output speed (tokens/sec after first token), total response time for 100
  output tokens, and end-to-end response time.
- Cadence: 1k and 10k input-token and vision workloads **8 times per day (~every 3
  hours)**; parallel-workload tests **once daily at a random time**; the 100k input-token
  workload **once per week**.
- Published statistic: the **median (P50) over the trailing 72 hours** (14 days for the
  100k workload). **No p95 is published**, which is the percentile the spec's `p95_ms`
  dimension is stated in.
- All tests originate from **one VM in Google Cloud `us-central1-a`**, and the methodology
  concedes this "may advantage or disadvantage certain providers based on their server
  locations."
- Longer prompts raise both TTFT and per-token speed.

Inference: 8 samples/day from a single us-central1 VM, reported as a 72-hour median, is a
comparison benchmark, not a floor. It cannot ground a p95 target, it embeds one network
vantage point, and its sample count per 5-minute window is zero — the spec's measurement
window is denser than this source's entire daily sample.

## 4. Prior art: does anyone pre-validate a performance target?

**Negative result. No surveyed router validates a declared performance target at
configuration time.** Every mechanism found is reactive (observed), a filter (drop
candidates that fail a threshold at request time), or a hand-set static.

    Source: https://docs.litellm.ai/docs/routing — LiteLLM Router
    Retrieved: 2026-08-15

- LiteLLM ships weighted-pick, latency-based ("picks the deployment with the lowest
  response time"), cost-based (against `litellm_model_cost_map`), usage-based, and
  least-busy strategies. Latency routing is tuned with `routing_strategy_args: {"ttl":
  10}` — a lookback window over **observed** latencies, with cooldowns and fallbacks
  after failure. **No configuration-time validation of a target exists**; a user cannot
  declare "hold p95 under 400 ms" and be told it is impossible.
- OpenRouter's `preferred_max_latency` is the closest published mechanism, and it is a
  *request-time filter over measured metrics*: candidates failing the threshold are
  excluded, and if none qualify the request fails or falls back — the customer learns at
  traffic time, not at write time.
- Portkey conditional routing routes on request metadata (user plan, model parameters,
  geography, environment flags) — declarative, but no performance predicate and no
  feasibility check.
- Vercel AI Gateway publishes the p50/p95 data (§3) but documents it as
  discovery/observability; routing config is provider ordering, fallbacks, timeouts, and
  service tiers. It does not reject a configuration.

Inference: the ticket asked whether prior art "quietly skips the check." It does — but
the reason is now visible. Nobody validates declaration-time feasibility because the
industry's own inputs (§1) do not support it; the vendors that hold the necessary data
(Vercel, OpenRouter) hold it as *observed* measurement, which by definition cannot be
consulted before traffic exists unless you accept another party's traffic as your prior.
This makes `infeasible_by_declaration` genuinely differentiating **and** explains why it
is unclaimed — the same conclusion the competitive-landscape reference reached about
target-state routing generally.

## 5. Staleness, change notification, and recourse

- **No provider publishes a change feed for performance characteristics**, because none
  publishes the characteristics. Model *deprecation* and *pricing* changes are announced
  through changelogs and deprecation pages; latency and availability behavior changes
  silently.
- **Published commitments themselves are volatile.** Anthropic's Priority Tier — the
  source of the only public Anthropic uptime number (99.5%) — is closed to new purchase
  as of the retrieval date, and excludes the four newest models. A floor catalogue
  citing it would have gone stale without any notification event.
- **Measured sources go stale fast and silently.** Vercel's windows are 15 minutes / 1
  hour / 1 day; OpenRouter's are 5 minutes / 30 minutes / 1 day. Artificial Analysis
  publishes a 72-hour median refreshed 8×/day. None of the three emits a change
  notification; all are pull-only.
- **Recourse when a floor turns out wrong is service credits on availability only, and
  nothing on latency.** Bedrock: 10/25/100% credits by uptime band, requested within two
  billing cycles, per region, excluding anything outside AWS's control. Azure: an
  availability credit schedule plus a 99% latency SLA restricted to Provisioned-Managed
  deployments. OpenAI: credits against private enterprise latency SLAs only. Anthropic
  standard tier: none. In every case the credit accrues **to the party holding the
  provider contract** — which, for a BYOK gateway, is the customer, not us. A wrong floor
  in our catalogue produces a wrong 422 for which no provider owes anybody anything.

## What this means for #6 (repository inference)

Declaration-time feasibility is **viable, but not as currently specified.** Three changes
are needed; none of them is a retreat from the ADR's two-state model.

1. **Re-key the floor.** `providers/capabilities.ts` must be keyed per **(model, host,
   region, service tier)**, not per model. The 86%/165% p50/p95 spread across hosts for
   one model (§3) makes the per-model key produce wrong answers in both directions. If
   the gateway routes to only one host per model at first, the key still must carry the
   host so the catalogue does not silently mean something else when a second host is
   added.
2. **Source latency floors from measurement, and say so in the rejection.** No provider
   publishes one, so the catalogue's latency values are either our own probe data or a
   third party's. The `infeasible_by_declaration` message the spec requires — "p95 400 ms
   requested; the fastest allowed model floors at 780 ms" — should name the floor's
   **provenance and age**, because the customer's recourse against a wrong floor is to
   dispute it, and a bare number cannot be disputed. This also matches the spec's
   framing of both reports as diagnoses rather than alarms.
3. **Make the cost floor a function of workload shape.** A single
   `cost_per_1k_tokens_usd` per model does not exist at any provider (§2). Either the
   target document carries an assumed input:output ratio and context band, or the check
   states the shape it assumed in the rejection.

A fourth, softer consequence: because latency floors are measured and therefore decay,
the check should be **asymmetric** — reject only when the target is infeasible against
the *most optimistic* floor in the candidate set by a margin exceeding the floor's own
observed variance. Rejecting a write is irreversible from the customer's side within that
request; a false 422 on a target that was actually achievable is a worse failure than
letting a marginal target through and reporting `unmet` two windows later, which is what
the second state exists for.

What does **not** hold up: any design that treats the floor as a published provider fact
requiring no maintenance. The ADR already accepted the catalogue as a cost ("a catalogue
it must maintain and keep honest"); this research prices that cost — it is a continuous
measurement obligation per (model, host, region, tier), not a quarterly docs scrape.
