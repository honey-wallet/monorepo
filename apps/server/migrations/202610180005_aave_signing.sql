-- Exact wallet signing terms are installed in the preparation transaction.
CREATE TABLE aave_signing_requests (
 operation_id uuid PRIMARY KEY REFERENCES operation_preparations(operation_id),
 canonical_json text NOT NULL CHECK (octet_length(canonical_json) BETWEEN 2 AND 49152),
 request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32)
);
CREATE TRIGGER immutable_aave_signing BEFORE UPDATE OR DELETE ON aave_signing_requests
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
CREATE INDEX aave_intent_service ON operation_intents ((canonical_json::jsonb->>'service'));
