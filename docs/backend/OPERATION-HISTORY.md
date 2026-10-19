# Durable operation discovery and restart recovery

Status: implemented for authenticated Honey operations. This is request history, not
an external wallet indexer or a claim that all on-chain activity/positions are connected.
It works independently of provider execution configuration and never signs or retries
transactions while loading a page.

## API contract

`GET /api/v1/operations?limit=20&cursor=<operation-uuid>` requires the existing bearer
session. `limit` defaults to 20 and must be 1–50. Unknown/duplicate/malformed query
fields are rejected. The principal and wallet come only from the authenticated session;
there are no public `user_id`/`wallet_id` filters. The list has a separate shared database
quota of 30 reads per minute per wallet. It uses the standard no-store HTTP envelope.

Response:

```json
{
  "items": [
    {
      "operation": {
        "id": "00000000-0000-4000-8000-000000000001",
        "walletId": "00000000-0000-4000-8000-000000000002",
        "action": "earn",
        "state": "created",
        "version": "0"
      },
      "createdAtMs": 1792320000000,
      "updatedAtMs": 1792320000000
    }
  ],
  "nextCursor": null
}
```

Summaries contain no arbitrary intent, calldata, signatures, idempotency keys, hashes of
intent bodies, queue payloads or credentials. Amount/provider-specific review is a
separate owner-scoped request. Versions remain decimal strings. The cursor is the last
returned operation UUID when more rows exist; it is not a credential or a signed grant.
The server resolves its exact creation timestamp **inside the same user and wallet
scope**. A missing/foreign anchor returns the same 404. Tampering can at most select a
different anchor the caller already owns, never broaden authority.

Rows are ordered by `(created_at DESC, id DESC)` using full PostgreSQL timestamp
precision. The displayed millisecond timestamps are not pagination keys. A page selects
`limit + 1` rows to determine whether another page exists. There is no total count, offset
scan, per-item detail hydration or held transaction while a user browses. A first page
uses one query; a subsequent page uses an anchor lookup and one range query.

This is a live keyset traversal, not a retained database snapshot. Newer insertions are
seen by refreshing the first page. Updates to an operation's state do not reorder it.
Tied timestamps use UUID ordering. A newer item inserted with an earlier creation time
would follow its stored ordering; the application never rewrites creation timestamps.
Opening an item uses the existing verified recovery endpoint and may show a newer state
than its list summary. There is no client-side inference of success from a list row.

## Resuming unsigned Aave requests

`GET /api/v1/operations/{id}/aave-intent` returns only the validated immutable Aave intent:
operation ID, signer, chain, asset, registry/fee revisions, action, raw amount and requested
network fee ceiling. The existing recovery integrity check validates the stored intent
hash first. Generic, legacy or foreign intents cannot become typed Aave requests by
passing arbitrary JSON through this endpoint.

Native Savings can reopen an unexpired `awaiting_signature` request. It loads the saved
intent, compares the current execution registry/fee revision/asset and active wallet,
and presents a **new explicit review**. The signing request still comes from the immutable
nonce/gas/fee record. The existing independent calldata/economic checks and device-confirmation
flow run again. Discovery does not generate new signatures or replay signed payloads.
Signed/unknown/confirming requests offer status and receipt recovery. Expired unsigned
plans remain visible and cannot be signed. A disabled provider service stops new Aave
reviews, while generic history and receipts remain available.

## Frontend integration and lifecycle

- Native real-wallet Activity now renders authenticated Honey request history instead
  of the demo-derived empty history. Savings uses the same component and supports the
  explicit unsigned-Aave reopening path. Demo/shared proposal flows remain separate.
- History is keyed by the proven server-wallet identity and checked against the active
  wallet address. Logging out or switching wallets removes the prior view's state.
- Web sign-in renders the same typed discovery/recovery contract after authentication.
  It is read-only; web transaction signing is still a separate unfinished integration.
- Both surfaces display ten items per page and fetch older pages on request. Memory
  does not grow with pages visited. A selected nonterminal operation refreshes every
  five seconds; terminal details stop polling. Hidden/background/unmounted views abort
  in-flight reads and discard late responses. Native focus loss also stops work.
- Bearers stay in the existing memory session and HTTP headers. No operation signatures
  or tokens are stored to support restart. After signing in again, server-side discovery
  supplies the owned IDs; the application does not need to retain them locally.

The native execution flow still needs its final amount-entry/tray treatment and a
physical-device acceptance pass. Watched-address and external on-chain activity,
search/filtering across all historical records, pending-operation prioritization,
exports and push notifications are not implemented by this change. First-page browsing
is bounded; a user with a large history can page backward explicitly.

## Index migration and operations

Migration `202610180006_operation_history.sql` adds
`operations_wallet_page(user_id,wallet_id,created_at DESC,id DESC)`. SQLx marks this
migration `no_tx=true` because it uses `CREATE INDEX CONCURRENTLY`. Authentication
readiness now requires migration 6, and startup still never migrates automatically.
The prior user-only index remains because it may serve other owner-level queries.

Concurrent index construction permits normal writes but uses more work and can leave
an invalid index after interruption. It cannot run inside a transaction block.
[PostgreSQL 17 documents these tradeoffs and recovery behavior](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

Before applying this to an existing populated deployment, an operator must budget build
I/O and set an appropriate migration statement timeout; the ordinary service timeout
is deliberately short. Inspect `_sqlx_migrations`, `pg_index.indisvalid`, index definition
and `pg_stat_progress_create_index` after a failed/interrupted command. SQLx 0.8.6 records
success after executing this nontransactional statement, so a completed index can also
outlive a crash before migration bookkeeping. Do not use `IF NOT EXISTS` to silently
accept an invalid/wrong index. Repair/rebuild and reconcile bookkeeping under an explicit
operator-reviewed procedure; the application does not drop or alter production indexes.
All changes executed here were on uniquely created disposable test databases.

## Evidence and limits

Tests cover full-precision pagination, equal timestamps, newer insertion between pages,
state changes without reordering, two wallets under one principal, foreign/missing cursors,
query bounds, malformed bodies, absence of sensitive fields and typed-intent ownership.
Shared-client tests reject mixed-wallet pages, duplicates, wrong cursors, unsafe numeric
shapes and mismatched operation responses. Web tests cover a fresh session mount,
read-only detail recovery, cursor traversal, wrong-wallet responses and unmount cancellation.

[Captured query evidence](evidence/operation-history-query-2026-10-18.json) uses 100,001
local operation rows split across two wallets under one principal. A page after the
900th row of a 1,001-row wallet history used `operations_wallet_page`, returned 11 rows
including lookahead, and executed in 0.167 ms on that warm local fixture. The original
single-wallet fixture selected the valid older user index; the final interleaved-wallet
fixture exercises the reason for the new index. This is query-plan evidence, **not** a
10k-concurrent-user throughput or production latency result.

[Captured HTTP/fork acceptance evidence](evidence/operation-history-http-local-fork-2026-10-18.json)
confirms that the script discovers operations and their original typed intent
after server restart, then disables Aave execution and checks that both completed operations
remain readable. Its test transactions are on a disposable local fork; no public broadcasts
or production migration are involved. Repro is the Aave HTTP smoke command in [AAVE-API.md](AAVE-API.md).
