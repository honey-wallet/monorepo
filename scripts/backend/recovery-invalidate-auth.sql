-- OFFLINE RESTORE ONLY. Run against the restored database with psql -X -v
-- ON_ERROR_STOP=1 -f recovery-invalidate-auth.sql before reopening ingress.
-- Stop/fence every old API and worker first; keep all application processes
-- stopped until this transaction commits. Locks do not prevent a restarted
-- application from issuing new credentials after commit.
--
-- A backup can resurrect revoked sessions, spent refresh tokens and consumed
-- proofs. Invalidate all restored credentials, including expired records, while
-- retaining audit/replay evidence and wallet ownership. This does not reconcile
-- financial operations, rotate wallet keys or authorize a deployment restart.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
LOCK TABLE auth_sessions, auth_refresh_families, auth_refresh_tokens,
    auth_challenges, wallet_link_challenges IN ACCESS EXCLUSIVE MODE;

UPDATE auth_sessions SET revoked_at = transaction_timestamp()
WHERE revoked_at IS NULL;
UPDATE auth_refresh_families SET revoked_at = transaction_timestamp()
WHERE revoked_at IS NULL;
UPDATE auth_challenges SET consumed_at = transaction_timestamp()
WHERE consumed_at IS NULL;
UPDATE wallet_link_challenges SET consumed_at = transaction_timestamp()
WHERE consumed_at IS NULL;
COMMIT;
