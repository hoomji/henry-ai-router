# Incident-only gateway interception mechanisms

Source: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-configuring.html — Configuring DNS failover (Amazon Route 53 Developer Guide)
Retrieved: 2026-08-15

Additional sources (all retrieved 2026-08-15):

- https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-how-route-53-chooses-records.html — How Route 53 chooses records when health checking is configured
- https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html — Active-active and active-passive failover
- https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html — Health check request interval and failure threshold values
- https://aws.amazon.com/blogs/aws/route-53-health-check-improvements-faster-interval-and-configurable-failover/ — Route 53 fast (10 s) health-check interval announcement
- https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/InetAddress.html — JDK InetAddress DNS caching (`networkaddress.cache.ttl`)
- https://github.com/openai/openai-python — OpenAI Python SDK README (`base_url` / `OPENAI_BASE_URL`)
- https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/python — Anthropic Python SDK (`base_url` / `ANTHROPIC_BASE_URL`)
- https://launchdarkly.com/docs/tutorials/ld-arch-deep-dive and https://launchdarkly.com/blog/launchdarklys-evolution-from-polling-to-streaming/ — control-plane push (SSE streaming, ~200 ms propagation) vs. polling
- https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/dynamic_configuration — Envoy xDS dynamic configuration (CDS/EDS/RDS/LDS/ADS)
- https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/aggregate_cluster — Envoy aggregate cluster (cross-cluster failover)

Resolves wayfinder research ticket [#4](https://github.com/hoomji/henry-ai-router/issues/4).
Repository consumers: the provider-risk gateway product spec (issue #8, spec behavior 2 —
gateway out of the request path normally, inserted only during a provider incident).

## Question

What deployment mechanisms can put a gateway INTO the request path only while a provider
incident is in progress, and out of it otherwise? Compared: DNS-based failover, SDK
base-URL switching (push vs. poll), sidecar/egress-proxy toggling, provider-side
redirects. For each: insertion latency after incident declaration, customer install
burden, failure modes, and auditability of the incident window (explicit start/end).

## Mechanism 1: DNS-based failover (health-checked DNS, e.g. Route 53)

Design: customer points their SDK at a vanity hostname (e.g. `llm.customer.example`)
whose primary record resolves to the provider (or a CNAME to it) and whose secondary
record resolves to the gateway. Route 53 failover routing returns only the primary while
its health check passes and switches to the secondary when it fails.

Sourced facts:

- Route 53 failover routing (active-passive): "If Route 53 considers the primary record
  unhealthy and the secondary record healthy, Route 53 returns the secondary record
  instead." If both are unhealthy it returns the primary. If the secondary has no health
  check, it is always used once the primary fails (health-checks-how-route-53-chooses-records).
- Health checks run at a 30 s default interval, reducible to 10 s ("fast"); the failure
  threshold is 1–10 consecutive observations, default 3 (health-checks-creating-values;
  AWS blog announcement of the 10 s interval).
- Health checks run continuously against the endpoint, not at query time ("Route 53
  periodically checks the health of the endpoint... it doesn't perform the health check
  when the DNS query arrives").
- AWS guidance for timely failover is a record TTL of 60 seconds.
- Client-side caching can exceed the record TTL: the JDK caches successful lookups for an
  "implementation-specific period", and with a security manager installed caches them
  forever unless `networkaddress.cache.ttl` is set (InetAddress docs).

Inference for this repo:

- Insertion latency = detection (interval × threshold: 30 s with fast checks, 90 s
  default) + record TTL (60 s) + client cache slop. Realistic p50 ≈ 1–2 minutes;
  the long tail is unbounded because resolvers and runtimes may ignore TTLs, and
  **existing keep-alive connections never re-resolve DNS at all** — long-lived HTTP/2
  connections to the provider keep flowing to the provider until they close.
- Manual insertion (operator declares incident, flips the health check or record) has the
  same TTL-bound latency but a human-controlled, auditable trigger; Route 53 change
  history plus health-check status logs give explicit start/end timestamps.
- Customer install: one-time base-URL change to the vanity hostname — but that hostname
  must serve valid TLS for a domain the gateway controls, which means the gateway (or
  customer) terminates TLS even in the "bypass" state unless the primary record points at
  customer-owned infrastructure. A CNAME to `api.openai.com` fails TLS/SNI and Host
  validation (repository inference; providers validate the Host header against their
  cert). In practice DNS failover therefore degenerates to "gateway-in-path with two DNS
  states", not true absence from the path, unless the primary state routes around the
  gateway at the customer's own edge.
- Failure modes: TTL disobedience, keep-alive pinning, negative caching, and the
  TLS/Host problem above. Flip-back (incident end) suffers the same latency, blurring the
  audit boundary.

## Mechanism 2: Customer-SDK base-URL switching (control-plane push or poll)

Design: SDK keeps its normal `base_url` pointed directly at the provider; a thin config
client (feature-flag style) swaps it to the gateway URL when the control plane declares
an incident, and swaps it back on incident end.

Sourced facts:

- OpenAI Python SDK: `base_url` is a client constructor parameter, "or use the
  `OPENAI_BASE_URL` env var" (openai-python README). The entire OpenAI-compatible
  ecosystem keys off this one knob.
- Anthropic Python SDK: identical shape — `base_url="http://my.test.server..."`, "Or use
  the `ANTHROPIC_BASE_URL` env var" (Anthropic Python SDK docs, Configuring the HTTP
  client section).
- Control-plane push is a solved pattern: LaunchDarkly server-side SDKs hold a persistent
  SSE stream and propagate flag changes in ~200 ms, versus polling "every 30 seconds or
  longer" (LaunchDarkly architecture deep-dive and evolution-from-polling-to-streaming).

Inference for this repo:

- Insertion latency: push ≈ sub-second after incident declaration; polling ≈ poll
  interval (30–60 s is conventional and still beats DNS because there is no resolver
  cache in the loop). New requests pick up the new base URL immediately; in-flight
  requests complete against the old target — a clean, well-defined boundary.
- Customer install: a small wrapper/config client per language, or — zero-code floor —
  the customer's own ops flipping `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` and restarting,
  driven by a status webhook. The wrapper is the product surface: it can also stamp each
  request with the incident ID.
- Normal operation is genuinely zero-touch: traffic goes SDK → provider with the gateway
  nowhere in the path, no TLS termination, no added hop, no shared fate.
- Failure modes: the config client itself (fail-safe default must be "provider direct");
  customers who construct clients once at boot and never re-read config (wrapper must
  re-evaluate per request or hold a mutable reference); polling staleness at incident end.
- Auditability: strongest of all options. The control plane records incident start/end as
  explicit configuration versions; the wrapper can tag every rerouted request; both sides
  of the boundary are timestamped events, not cache expirations.

## Mechanism 3: Sidecar / egress-proxy toggling (Envoy dynamic config)

Design: customer already runs (or installs) an egress proxy; its route/cluster config is
updated at runtime by an xDS control plane to send provider-bound traffic to the gateway
during an incident.

Sourced facts:

- Envoy xDS updates clusters and routes at runtime without restart: via CDS "Envoy will
  gracefully add, update, and remove clusters", and via RDS "the route configuration will
  be gracefully swapped in without affecting existing requests" (dynamic_configuration).
- Aggregate clusters exist specifically "for failover between clusters with different
  configuration"; fallback priority is the ordering of the clusters list
  (aggregate_cluster). This enables automatic in-proxy failover, not just pushed toggles.

Inference for this repo:

- Insertion latency: xDS push is effectively immediate (single gRPC stream update, no
  cache layer); an aggregate-cluster/outlier-detection setup can even fail over
  per-request without any control-plane round trip. Sub-second.
- Customer install: heavy — an Envoy (or mesh) deployment plus trust in an external xDS
  control plane, or config-reload automation on their existing proxy. Only credible for
  customers who already run a service mesh; as a required install it is the highest-friction
  option and duplicates Mechanism 2's outcome.
- Failure modes: the proxy is now in-path for ALL traffic all the time (it is the proxy
  that is bypass-by-default at the routing layer, not at the network layer), so proxy
  availability becomes shared fate; TLS to the provider must be originated by the proxy.
- Auditability: good — xDS config versions and Envoy access logs bound the window — but
  the audit trail lives in customer infrastructure, not the product's control plane.

## Mechanism 4: Provider-side redirects

Sourced facts (negative result): neither OpenAI's nor Anthropic's SDK/API documentation
(openai-python README; Anthropic SDK and API docs reviewed above) documents any
customer-configurable redirect, traffic-forwarding, or failover-target mechanism on the
provider side. HTTP 307/308 redirects exist as protocol machinery, but nothing lets a
customer register "send my traffic elsewhere during your incident."

Inference for this repo: even if it existed, it fate-shares with the incident — the
failing provider must be healthy enough to serve the redirect, and hard outages (the
exact trigger) are when it cannot. Not a viable mechanism; exclude from the spec.

## Comparison

| Mechanism | Insertion latency | Customer installs | Bypass truly out-of-path? | Audit boundary |
|---|---|---|---|---|
| DNS failover (Route 53) | ~1–2 min p50; unbounded tail (client caches, keep-alive pinning) | Base-URL change to vanity host; TLS problem in bypass state | No — vanity host implies in-path TLS or customer edge | Fuzzy: TTL-smeared start/end |
| SDK base-URL switch | Push <1 s; poll = interval (30–60 s) | Thin wrapper or env-var + webhook | Yes — direct-to-provider normally | Explicit: config versions + per-request tags |
| Envoy/sidecar toggle | <1 s (xDS push) or per-request (aggregate cluster) | Envoy/mesh + xDS trust (heavy) | Network-level no; routing-level yes | Good, but customer-held |
| Provider redirect | n/a | n/a | n/a | n/a — mechanism does not exist |

## Conclusion

Incident-only routing is technically credible, but only via the client side. The spec
should assume **SDK base-URL switching driven by a control-plane push (streaming, with
polling fallback)** as the primary mechanism: it is the only option that is genuinely out
of the request path in normal operation, inserts in sub-second-to-seconds after an
explicit incident declaration, needs nothing heavier than a thin wrapper around the
`base_url`/`OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` knob every OpenAI-compatible SDK
already exposes, and yields an explicit, timestamped incident window (declaration event →
clearance event, with per-request incident tagging). Support **Envoy/mesh xDS
integration** as a secondary path for customers who already operate an egress proxy — do
not require it. Treat **DNS failover** as a fallback distribution channel at best (its
TTL smear and keep-alive pinning violate the spec's explicit start/end boundary, and the
bypass state is not actually out-of-path). **Provider-side redirects do not exist** and
would fate-share with the incident; exclude them.
