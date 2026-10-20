# NEAR Intents bridge provider

NEAR Intents replaces Across as the planned bridge provider alongside Relay.
The active server no longer mounts Across quote, prepare, signing or submission
routes, constructs its adapters, or starts its execution worker. Existing Across
database migrations, evidence readers and compatibility code remain for historical
operations; those records must not be deleted or reinterpreted as NEAR Intents.
Old `ACROSS_QUOTE_CONFIG_FILE` / `ACROSS_EXECUTION_CONFIG_FILE` settings fail startup.

## Available now

Set server-only `NEAR_INTENTS_API_KEY` to a partner JWT. Authentication, PostgreSQL
and Redis are required. Never expose the partner JWT to mobile/web clients.

- `GET /api/v1/bridges/near-intents/tokens`: authenticated token catalog with
  projected asset ID, chain, symbol, decimals and nullable contract address.
- `POST /api/v1/bridges/near-intents/quote`: authenticated exact-input preview.
  Input is `originAsset`, `destinationAsset`, atomic-unit `amount`, `recipient`
  and integer `slippageTolerance` in basis points (0–500).

The server forces `dry: true`, `EXACT_INPUT`, `ORIGIN_CHAIN` deposits/refunds and
`DESTINATION_CHAIN` delivery. Refund address comes from the authenticated wallet;
deadline is server-generated. Clients cannot supply fees, executable fields or
provider URLs. The source asset must belong to the authenticated EVM chain in
1Click's catalog. Currently supported source chains: Ethereum, Base, Arbitrum,
Optimism, Polygon, BSC, Avalanche and Gnosis. Destination assets may use any
supported catalog chain; non-EVM source ownership is not implemented.

Transport pins `https://1click.chaindefuser.com/v0`, disables redirects, bounds
response size/time/concurrency and uses shared Redis pacing/cooldown. The quote
must match the submitted terms, have a recent timestamp and verify against the
official 1Click production Ed25519 manager key using the SDK's deterministic
signed-field projection. The compatibility test uses the official staging vector;
that staging key is never trusted in production.

Responses contain atomic input/output/minimum-output amounts and quote timestamp.
No deposit addresses, memos, transaction data or signing requests are exposed.
Capabilities advertise `near_intents` as a planned provider and as a configured
read-only quote provider only when its adapter exists. Bridge execution stays
unavailable. No frontend components are changed by this provider replacement.

## Remaining before production execution

Live partner-key acceptance and provider quotas remain unverified. Non-dry quote
creation, immutable owner-bound quote/deposit persistence, source-chain signing,
deposit submission, restart-safe polling, and independently verified destination
settlement/refund accounting are not implemented. A provider `SUCCESS` or
`REFUNDED` status alone must not settle a wallet operation. Handle deposit memos,
partial/late deposits, expired quotes, duplicate submissions and recovery after
process crashes before enabling transfers. Never translate an Across preparation
or deposit ID into a NEAR Intents order.

References (checked 2026-10-21):
[quote API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote),
[API keys](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication),
[signature contract and SDK](https://github.com/defuse-protocol/one-click-sdk-typescript/blob/main/src/quote-signature.ts).
