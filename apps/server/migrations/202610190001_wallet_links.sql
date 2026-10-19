-- Additional wallets require fresh proof and an authenticated live session.
-- The challenge is bound to the session digest so logout/expiry invalidates it.
CREATE TABLE wallet_link_challenges (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    session_hash bytea NOT NULL CHECK (octet_length(session_hash) = 32),
    message text NOT NULL CHECK (octet_length(message) <= 2048),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX wallet_link_challenges_expiry ON wallet_link_challenges(expires_at);

ALTER TABLE identity_events DROP CONSTRAINT identity_events_kind_check;
ALTER TABLE identity_events ADD CONSTRAINT identity_events_kind_check
    CHECK (kind IN ('signed_in', 'signed_out', 'wallet_linked'));
