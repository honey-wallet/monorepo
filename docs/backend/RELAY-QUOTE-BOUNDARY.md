# Relay quote boundary

This note began as the shared request-contract review before a server adapter
existed. The current implementation has an authenticated Relay v2 quote-preview
endpoint; it still does not persist quotes, expose credentials, return executable
steps, sign, submit or mark a bridge as supported. For the implemented endpoint,
read [RELAY-QUOTE-PREVIEW.md](RELAY-QUOTE-PREVIEW.md) and
[IMPLEMENTATION.md](IMPLEMENTATION.md).

## Evidence

Relay's live OpenAPI document identifies itself as version `1.0.0` and currently
describes `POST /quote/v2` as the quote endpoint. Its required request fields are
`user`, `originChainId`, `destinationChainId`, `originCurrency`,
`destinationCurrency`, `amount`, and `tradeType`. It defines amount as a
smallest-unit integer string and trade types as `EXACT_INPUT`, `EXACT_OUTPUT`,
and `EXPECTED_OUTPUT`. Currency identifiers span several virtual machines;
this initial validator intentionally accepts only EVM addresses and the EVM
native-currency zero address.

The quote response is an ordered sequence of heterogeneous transaction and
signature steps. Relay says the sequence must be executed in order, and step
checks may include provider endpoints. The API's fee breakdown distinguishes
gas, relayer, protocol and app fees; app fees accrue to the app and are claimed
later. Therefore, this request validator does not imply that a response is safe
to display as an executable plan, and it rejects unreviewed execution options
such as `txs` and `appFees` rather than silently forwarding them.

Sources (retrieved 2026-10-18):

- [Relay OpenAPI JSON](https://api.relay.link/documentation/json), OpenAPI
  `3.0.3`, API version `1.0.0`, `POST /quote/v2`.
- [Relay quote API reference](https://docs.relay.link/references/api/get-quote-v2).
- [Relay step execution](https://docs.relay.link/references/api/api_core_concepts/step-execution).
- [Relay fee structure](https://docs.relay.link/references/api/api_core_concepts/fees).

## Local contract

`packages/api-client/src/relay-quote.ts` validates the narrow EVM request and
projects exactly those reviewed fields into a new object. It requires a safe
positive integer chain ID, EVM addresses, a canonical positive decimal amount no
greater than the EVM `uint256` maximum, and one of Relay's three documented trade types. It
rejects extra keys so future callers cannot accidentally send a fee recipient,
arbitrary calls, or experimental Relay options through this contract.

The request projection remains a narrow client-side contract. The implemented
server preview uses a fixed Relay origin, bounded response size/deadlines,
Redis-shared pacing, authenticated owner binding, and a response projection that
treats provider step URLs as data rather than fetch targets. Execution still
needs per-step chain/target/calldata validation, fee semantics, signing and
recovery tests, and provider/account compatibility evidence. Relay status
observations remain advisory and do not prove settlement.
