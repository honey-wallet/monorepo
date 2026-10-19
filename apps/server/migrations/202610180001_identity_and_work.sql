-- Forward-only foundation. Apply using an explicit migration command, never on API startup.
CREATE TABLE users (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Each proven EOA identifies one principal. Linking additional wallets requires a
-- separate, authenticated proof protocol; addresses never identify an email user.
CREATE TABLE wallet_memberships (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    chain_id bigint NOT NULL CHECK (chain_id > 0),
    address bytea NOT NULL CHECK (octet_length(address) = 20),
    account_kind text NOT NULL CHECK (account_kind = 'eoa'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (chain_id, address),
    UNIQUE (id, user_id)
);
CREATE INDEX wallet_memberships_user ON wallet_memberships(user_id);

CREATE TABLE auth_challenges (
    id uuid PRIMARY KEY,
    message text NOT NULL CHECK (octet_length(message) <= 2048),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

-- Bearers are random opaque credentials. Only their SHA-256 digests are stored.
-- Initial implementation deliberately requires another signature after 15 minutes;
-- no refresh credentials are issued until rotation and secure client persistence ship.
CREATE TABLE auth_sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id uuid NOT NULL REFERENCES users(id),
    wallet_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id)
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

-- One atomic fixed-window counter per pseudonymous subject/action. Used only for
-- low-volume identity endpoints; not the eventual market-data rate limiter.
CREATE TABLE auth_rate_limits (
    subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
    window_start timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts > 0),
    PRIMARY KEY (subject_hash, window_start)
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(window_start);

CREATE TABLE operations (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    wallet_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('transfer', 'swap', 'bridge', 'earn', 'perps', 'prediction')),
    idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128),
    intent_hash bytea NOT NULL CHECK (octet_length(intent_hash) = 32),
    state text NOT NULL DEFAULT 'created' CHECK (state IN
        ('created', 'awaiting_signature', 'submitted', 'confirming', 'succeeded', 'failed', 'unknown')),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id),
    UNIQUE (user_id, action, idempotency_key)
);
CREATE INDEX operations_user_page ON operations(user_id, created_at DESC, id DESC);

-- Transactional outbox and queue share one durable table. There is no publish gap:
-- the business transaction inserts work; workers claim it directly in PostgreSQL.
-- Payloads contain public IDs/metadata only, never signable payloads or credentials.
CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    topic text NOT NULL CHECK (topic IN ('operation.created', 'operation.changed')),
    operation_id uuid NOT NULL REFERENCES operations(id),
    operation_version bigint NOT NULL CHECK (operation_version >= 0),
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'leased', 'done', 'dead')),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 32),
    last_error_code text CHECK (last_error_code IN ('upstream_timeout', 'upstream_unavailable', 'invalid_response', 'lease_expired')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    UNIQUE (operation_id, operation_version),
    CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
    CHECK (state = 'leased' OR (lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX jobs_ready ON jobs(available_at, id) WHERE state = 'ready';
CREATE INDEX jobs_expired_lease ON jobs(lease_until, id) WHERE state = 'leased';

-- An immutable, minimal audit event lives in the same transaction as identity changes.
CREATE TABLE identity_events (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK (kind IN ('signed_in', 'signed_out')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX identity_events_user_page ON identity_events(user_id, created_at DESC, id DESC);
