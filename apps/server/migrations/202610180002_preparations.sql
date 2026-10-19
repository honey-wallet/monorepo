-- Additive, explicit migration; old digest-only operations remain readable but
-- cannot be prepared because their original intent cannot be reconstructed.
CREATE TABLE operation_intents (
    operation_id uuid PRIMARY KEY REFERENCES operations(id),
    canonical_json text NOT NULL CHECK (octet_length(canonical_json) BETWEEN 2 AND 8192),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE operation_preparations (
    operation_id uuid PRIMARY KEY REFERENCES operation_intents(operation_id),
    canonical_json text NOT NULL CHECK (octet_length(canonical_json) BETWEEN 2 AND 32768),
    plan_hash bytea NOT NULL CHECK (octet_length(plan_hash) = 32),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);

-- Immutable business evidence. Requoting creates a new operation/idempotency key;
-- it must not silently alter a plan already presented to the wallet.
CREATE FUNCTION reject_preparation_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'operation evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_operation_intent BEFORE UPDATE OR DELETE ON operation_intents
    FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
CREATE TRIGGER immutable_operation_preparation BEFORE UPDATE OR DELETE ON operation_preparations
    FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
