# External references

Durable external knowledge captured locally so agents do not depend on browser access,
private conversations, or human memory. Capture and retire entries with
`harness-reference`. Every reference appears in the table below exactly once.

| Reference | Source | Version or retrieved | Repository consumers | Owner | Review date |
|---|---|---|---|---|---|
| [AI gateway competitive landscape](2026-08-15-ai-gateway-competitive-landscape.md) | Vendor docs/pricing pages (OpenRouter, LiteLLM, Portkey, Martian/Thesean, Unify, Helicone, Cloudflare, Kong, AWS Bedrock; URLs inline) | Retrieved 2026-08-15 | Provider-risk gateway product spec; issues #3, #6, #7, #8 | hoomji | 2026-11-15 |
| [Incident-only gateway interception mechanisms](2026-08-15-incident-interception-mechanisms.md) | AWS Route 53 docs, OpenAI/Anthropic SDK docs, LaunchDarkly architecture docs, Envoy xDS docs | Retrieved 2026-08-15 | Provider-risk gateway product spec (issues #4, #8) | Henry | 2027-02-15 |
| [Strain-signal anonymization prior art](2026-08-15-strain-signal-anonymization.md) | Multiple (Cloudflare, Downdetector, W3C NEL, CrUX, RAPPOR, Privacy Sandbox, OpenRouter, Helicone) | Retrieved 2026-08-15 | Provider-risk gateway product spec, behavior 3 (issue #5) | hoomji | 2027-02-15 |

## Entry contract

Every reference file records its provenance before any summary, containing both markers
verbatim:

    Source: https://example.invalid/spec — [source title]
    Retrieved: [YYYY-MM-DD, or the pinned version]

- Keep a local copy only when a pinned version, a minimal excerpt, a normalized
  observation, or a durable summary is needed for reproducible work. Otherwise link.
- Every retained section supports a named repository consumer; material with no consumer
  is excluded.
- Separate sourced facts from repository inference, so a reader can tell which claims the
  source actually makes.
- Keep secrets, customer data, private transcripts, and licensed text that may not be
  redistributed out of this directory.
- Retire a reference only after every consumer is redirected; preserve a successor link
  where history needs it.
