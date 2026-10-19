# Relay quote preview boundary

`POST /api/v1/relay/quote` is an authenticated advisory preview. The server binds `user` to the authenticated wallet and requires the session's EVM chain to match `originChainId`. `RELAY_API_KEY` enables the adapter only when PostgreSQL authentication and Redis are configured. The request uses the existing exact-field contract in `packages/api-client/src/relay-quote.ts`.

The upstream origin is fixed to `https://api.relay.link/quote/v2`; clients cannot choose a URL, header or provider option. Honey always adds `indicativeQuote: true`, which Relay's live OpenAPI describes as “Whether to return an inexecutable quote meant to be used as a preview.” Honey does not trust an echoed flag: `executionAvailable: false` describes this API response contract, which omits all transaction and signature item payloads even if the upstream response contains them. Redis provides shared one-request-per-second provider pacing and cooldown across replicas; server admission also uses the existing global and per-wallet minute limits. The HTTP client rejects redirects, has a six-second request timeout and bounds the response body to 256 KiB. An in-process semaphore caps concurrent calls at four.

Relay documents a quote response as ordered steps with heterogeneous transaction and signature items. The adapter checks a bounded request ID, 1–16 unique ordered step IDs, supported step kinds, bounded display text, and item/status structure. It discards the complete upstream response after validation. The response contains only step index, ID, kind, display action/description and item count, with `executionAvailable: false`; no calldata, target, value, signature message, signing schema, check endpoint, fee artifact or raw provider data crosses the API boundary. The frontend client validates this display-only schema and sends the bearer token in the Authorization header.

The boundary intentionally does not report token economics or fees yet: Relay's response has nested, evolving `details`, `fees`, sponsorship and protocol structures, and this slice does not independently reconcile those values against the request. Step display strings are provider-controlled text and must be rendered as text, never interpreted as HTML. A preview is not an authorization, simulation, safety review or execution plan.

## Design tradeoffs

- Forcing Relay's `indicativeQuote` option and omitting all item data sharply reduces accidental signer exposure. The tradeoff is that the frontend can display route steps but cannot execute them from this endpoint.
- Redis fail-closed pacing shares a conservative fixed one-second spacing among replicas. This is simple and bounded but may underuse a larger API-key allowance; the provider key's actual quota remains unknown and must be confirmed before changing it.
- A four-call local semaphore limits per-replica memory and sockets, while Redis serializes start times. The local limit multiplies with replica count, so production concurrency still needs measured capacity and provider quota evidence.
- The API key is optional and secret-managed via environment; without it the route stays unavailable. Relay's official API reference says authenticated API keys are required for quote requests from October 2, 2026, so an actual operator-issued key and account acceptance remain external prerequisites.

## Evidence and blockers

Official Relay references:

- [Get Quote v2](https://docs.relay.link/references/api/get-quote-v2) documents the fixed endpoint, request projection, `indicativeQuote`, response fields and the API-key requirement dated October 2, 2026.
- [Understanding Step Execution](https://docs.relay.link/references/api/api_core_concepts/step-execution) says steps carry transaction/signature data that can be fed to wallet libraries, that step order and item order matter, and that descriptions are display text.
- [Relay OpenAPI JSON](https://api.relay.link/documentation/json) is version 1.0.0 and describes `POST /quote/v2`.

This implementation does not verify an actual API key, provider quota agreement, fee terms, external live quote, route eligibility, quote economics, or transaction safety. The existing Relay commit/reveal routes remain `NotImplemented`; there is no preparation, signing or submission path here. A live provider acceptance test and independent per-step execution review are required before building any executable integration.
