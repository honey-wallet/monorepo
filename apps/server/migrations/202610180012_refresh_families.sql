-- Opaque rotating refresh credentials. Only SHA-256 hashes are stored; spent
-- hashes remain until family expiry so reuse can revoke the entire device family.
ALTER TABLE auth_sessions ADD COLUMN refresh_family_id uuid;

CREATE TABLE auth_refresh_families (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    wallet_id uuid NOT NULL,
    device_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id)
);
CREATE INDEX auth_refresh_families_user ON auth_refresh_families(user_id);
CREATE INDEX auth_refresh_families_expiry ON auth_refresh_families(expires_at);
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_refresh_family_fk
    FOREIGN KEY (refresh_family_id) REFERENCES auth_refresh_families(id);
CREATE UNIQUE INDEX auth_sessions_one_active_per_family
    ON auth_sessions(refresh_family_id)
    WHERE refresh_family_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE auth_refresh_tokens (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    family_id uuid NOT NULL REFERENCES auth_refresh_families(id),
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_refresh_tokens_family ON auth_refresh_tokens(family_id);
