# Native NEAR

Honey's shared keyring supports native NEAR accounts, balance reads, and transfer
signing on mainnet and testnet. The mobile/Chrome execution service supports owner
authentication and pending-transfer recovery. Frontend screens and component
integration are left to the user; the NEAR-specific UI additions were removed.

## Accounts and recovery

- Phrase accounts use SLIP-10 Ed25519 at `m/44'/397'/<account index>'`.
  Account zero matches the NEAR seed-phrase library's default path.
- The receive address is the lowercase hex public key (a 64-character implicit
  account). A first native NEAR deposit creates it on chain.
- Existing phrase wallets gain the public address during wallet hydration.
  Other derived addresses and their derivation paths are unchanged.
- Backups and pairing carry the existing phrase and account indexes, so NEAR
  addresses recover on the other device without a new backup format.
- Imported EVM private keys and EVM watch addresses do not acquire NEAR accounts.
- Importing a phrase recovers its implicit accounts. It does **not** discover named
  accounts that happen to authorize the same key. Named accounts can be recipients.

## Transfers

The client reads finalized account state, storage requirements, and the full-access
key nonce from the selected NEAR RPC. Amounts use bigint yoctoNEAR throughout (24
decimals). The signer encodes exactly one native Transfer action and signs its SHA-256
digest locally. Secret keys are cleared after use; only signed bytes leave the device.

Callers must show the full destination, network, and exact amount before invoking
the execution service's device/password authentication. Prepared transfers expire
after 60 seconds. Wallet changes and duplicate calls
invalidate or block signing. Spendable balance excludes storage funding and a 0.01 NEAR
fee reserve. That reserve is not an exact fee quote or a protocol fee cap.

The encrypted vault saves the transaction hash and signed bytes **before** broadcast.
A timeout remains pending. Checking status after reopening queries the same hash; if
the RPC has no record, it may rebroadcast the identical signed bytes, never sign a new
transfer. Success requires a matching transaction and `FINAL` successful execution.
Final outcomes discard the saved signed bytes. An unresolved/expired transaction remains
pending and blocks another send on that account/network until reconciled; Honey does not
assume that a transport failure means the funds stayed put. Explorer URLs are available
in the shared network configuration.

## Boundaries

This is native NEAR support, not NEP-141 tokens, NFTs, staking, swaps, Wallet Selector,
NEP-413 signing, hardware wallets, named-account discovery, or Bunk key rotation.
The backend's Bunk capability matrix is unchanged. Test/demo mode cannot broadcast NEAR.
NEAR is not yet included in the USD portfolio total or backend operation history.
The execution service retains the most recent transfer
per account and network, rather than providing an indexed transaction history.

## Verification

`packages/keyring/src/fixtures/near.json` was generated offline with official
`near-api-js` 7.3.1 and `near-seed-phrase` 0.2.1 using the public BIP-39 test phrase.
Tests pin multiple account addresses and exact unsigned/signed transaction bytes.
Mock RPC and vault tests cover precision, account creation, reserves, full-access keys,
network mismatch, finality, signing cancellation, key clearing, and interrupted sends.
No dependency or lockfile changes are required.

A funded testnet transfer and physical-device authentication remain release checks;
automated verification does not move funds or start blockchain nodes.

References: [NEAR account model](https://github.com/near/nearcore/blob/master/docs/DataStructures/Account.md),
[NEAR derivation paths](https://github.com/near/near-slip10),
[transaction RPC](https://docs.near.org/api/rpc/transactions),
[protocol configuration](https://docs.near.org/api/rpc/protocol).
