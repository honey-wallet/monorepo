# Uniswap quote artifacts and calldata construction

Status: internal fixed-origin transport and independent response verification are
implemented. Public swap signing, fresh RPC/chain admission, execution workers and
live Trading API acceptance remain unfinished. This is not a production execution
capability. Design: D75–D76 in [DECISIONS.md](DECISIONS.md).

## Evidence and scope

The public [Trading API specification](https://trade-api.gateway.uniswap.org/v1/api.json)
was fetched again on 2026-10-18. Its SHA-256 remains
`2f46a6cb498f27461c219dd898f513e77d725ad10546435fb3b5e1ff4fdc2e2e`, matching the
quote research. The selected-schema artifact now includes `CreateSwapRequest`,
`CreateSwapResponse`, `SwapTransactionResponse`, deadline and safety-mode definitions.
The documentation page was unavailable through the browsing tool; the primary
OpenAPI endpoint was readable. No authenticated production response was obtained.

The source specifies `POST /swap` as calldata construction, with a quote and optional
Permit2 data/signature, numeric Unix deadline, provider simulation and refreshed gas
estimates. Sender omission is permitted for its separate `UNIVERSAL_ROUTER` filler
flow. Honey explicitly requests `WALLET` and requires the reviewed sender; no filler,
bridge, auction, native-token or exact-output route is enabled here.

## Validated quote artifact

`UniswapQuotes::quote_for_review` retains the normalized public quote, canonical raw
quote object, normalized optional PermitSingle terms and a configuration snapshot.
Its fields are private; public client JSON cannot deserialize this type. The existing
quote endpoint keeps its public response shape. Both paths reuse the strict route,
recipient, token, amount, fee, minimum and Permit2 normalizer.

Creating a review requires the artifact still be within its original 30-second
freshness window. The caller supplies the immutable operation intent hash, explicit
router deadline, network-fee ceiling and an explicit zero/one-base-unit fee-rounding
allowance. The review copies exact quote amounts and configuration revisions rather
than reconstructing them from displayed decimal amounts. Its stricter PermitSingle
lifetime rules can reject a quote that was acceptable for display. This is deliberate:
a display quote is not permission to sign.

Raw provider addresses may use checksum case. Binding compares their address bytes
against canonical public authority without rewriting the raw quote or its hash.
The service still owes product-intent binding and fresh verified chain observations.
Artifact construction alone proves neither the nonce nor sufficient allowance.

## Request construction from durable evidence

`UniswapQuotes::build_swap` takes the sensitive context loaded from the encrypted
review/permit repository. Before contacting the provider it:

- Checks review validity, expiry, chain, router, Permit2, registry/fee revisions,
  registered token vocabulary and configured fee recipients/rates.
- Rechecks the canonical raw quote hash and normalizes that exact quote under current
  configuration, preserving its original observation clock and reviewed minimum.
- Verifies that optional permit terms and signature appear together and prove the
  same EOA authority. Reconstructs the fixed PermitSingle EIP-712 schema; arbitrary
  provider/client type definitions are never forwarded as signing authority.
- Sends the unchanged quote object, the exact persisted signature where required,
  the reviewed numeric deadline, `simulateTransaction: false`, `refreshGasPrice: true`,
  `swapSource: WALLET` and `urgency: normal`. No-permit requests omit both permit fields.

Provider single-call simulation is disabled deliberately: a first swap may need an
ERC20 approval before the action. The existing Earn implementation shows the required
local `eth_simulateV1` sequence pattern; the future swap preparation must simulate
approvals and action together before accepting any Ethereum signing request. No
provider gas hint or successful construction can bypass that requirement. Current
quote normalization still rejects provider simulation failure reasons; interpreting
`TRANSFER_FROM_FAILED` as an approval prerequisite requires fresh allowance proof
and provider/fork acceptance, and is not enabled by this change.

The optional `safetyMode: SAFE` is deliberately omitted for this ERC20-only path.
The specification says SAFE appends a native-asset sweep, which the current economic
vocabulary does not support. Honey independently rejects any nonzero attached native
value and all wrapping/native-input routes. This avoids assuming that adding SAFE is
compatible with the verifier. Future native swaps need explicit native-value/refund
accounting and actual-contract evidence before changing this policy. If authenticated
provider builds append unsupported instructions anyway, they are rejected; this
remains an acceptance gate rather than a silent verifier relaxation.

## Shared transport and resource limits

Quote and build use the same fixed HTTPS origin, sensitive API-key header, explicit
router 2.1.2/Permit2-enabled headers, no redirects, four local in-flight slots and
Redis account-wide admission/cooldown. A build cannot bypass quote quota via another
replica. No automatic transport retries are issued. Transient build retries may be
orchestrated later only with the same immutable review/signature and before expiry.

The response stream is bounded at 256 KiB even without Content-Length. Build bodies
are bounded at 256 KiB plus 4 KiB for permit and control fields. Complete build work
is bounded by the lesser of 10 seconds or remaining review life; the transport checks
expiry again after quota admission, before sending. Construction requires a response
router-version header equal to 2.1.2. Missing/mismatched headers fail, so compatibility
must be established through actual provider acceptance before activation.

429/5xx responses and transport failure share the existing Redis cooldown. 401/403
hold the provider account until operational recovery. Provider error bodies are not
returned or logged. Response/request JSON wrappers and byte buffers wipe owned
strings on drop; reqwest and parser/runtime copies cannot be guaranteed erased.

## Independent response verification

The provider response is parsed into a private-construction `VerifiedSwapBuild` only
after the following checks:

- Exact reviewed chain, sender and router, zero native value, canonical supported
  router command ABI, fixed deadline, exact token spending and minimum receipt,
  allowed fee bounds, refund recipients and no unresolved token balance.
- A unique leading embedded permit where required, matching all persisted terms and
  proving EOA ownership; its signature must equal the exact stored encoding. No-permit
  contexts reject an unexpected embedded permit.
- No legacy gas price, provider nonce or unknown transaction fields. EIP-1559 gas
  hints are optional only as a complete group; when present they must be canonical,
  internally consistent and fit the reviewed network-fee ceiling. Reported gas cost
  is also bounded. Local estimation and nonce selection remain mandatory later.

Only `0`, `0x0` and `0x00` are accepted spellings of the zero-value field, covering the
specification's decimal shape and hex example without a permissive quantity parser.
Provider gas hints and provider simulation do not constitute local simulation or
Ethereum signing terms. The result carries provider request ID, quote ID and review
hash, with no Debug/Serialize implementation for the signed calldata.

Static `build` outcome/latency metrics share the existing provider metric family.
An economic rejection logs its bounded proof-failure category, never its calldata,
signature, provider body, wallet address or credential.

## Validation and remaining integration

Pure tests cover artifact freshness, checksummed provider addresses, exact request
reconstruction, no-permit omission, changed configuration/review/signature rejection,
identity/deadline/input/minimum/fee mutations, and all 16 supported no-permit economic
route fixtures. These include mixed V2/V3/V4 routes, multiple fees and refund flows.
They are synthetic responses, not authenticated provider fixtures.

The opt-in Redis/loopback tests check credential/header placement, exact deadline,
response version enforcement, redirect blocking, response-size limits, whole-build
expiry, shared quote/build cooldown across client instances and metric redaction.
CI now runs the Uniswap transport tests in its disposable-service job.

Required next work remains:

1. Integrate the internal [chain observer/preparer](UNISWAP-PREPARATION.md), which now
   has mock coverage, into review/permit admission and prove the path on actual
   forked contracts; bind the artifact to the operation intent.
2. Wire the service to the implemented atomic reviewed `building_swap → awaiting_signature`
   handoff; persistence now retains authenticated build/review provenance (D79).
3. Connect bounded authenticated HTTP commands, the dedicated durable worker and
   independent native review/sign/status recovery to that preparation flow.
4. Obtain authenticated provider quote/build acceptance and full-path fork evidence,
   including provider-added refund instructions. Never mark production capability
   available merely because these transport/unit tests pass.
