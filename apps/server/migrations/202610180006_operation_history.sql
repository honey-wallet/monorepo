-- Immutable creation order with principal AND wallet predicates; no OFFSET scan.
-- This migration runs outside a transaction. Interrupted builds can leave an
-- invalid index; inspect pg_index and follow OPERATION-HISTORY.md before retry.
CREATE INDEX CONCURRENTLY operations_wallet_page ON operations(user_id,wallet_id,created_at DESC,id DESC);
