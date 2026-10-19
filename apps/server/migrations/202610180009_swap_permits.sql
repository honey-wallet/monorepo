-- Explicit review precedes Permit2 signing; a signed permit is not an Ethereum
-- transaction submission. Existing API/workers must drain before new states appear.
ALTER TABLE operations DROP CONSTRAINT operations_state_check;
ALTER TABLE operations ADD CONSTRAINT operations_state_check CHECK (state IN
 ('created','awaiting_permit','building_swap','awaiting_signature','signed',
  'submitted','confirming','succeeded','failed','unknown'));
CREATE TABLE swap_reviews (
 operation_id uuid PRIMARY KEY REFERENCES operation_intents(operation_id),
 canonical_json text NOT NULL CHECK(octet_length(canonical_json) BETWEEN 2 AND 32768),
 review_hash bytea NOT NULL CHECK(octet_length(review_hash)=32),
 quote_hash bytea NOT NULL CHECK(octet_length(quote_hash)=32),
 expires_at timestamptz NOT NULL,
 key_id text NOT NULL CHECK(key_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 encryption_nonce bytea NOT NULL CHECK(octet_length(encryption_nonce)=24),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 18 AND 262160),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE TABLE swap_permit_signatures (
 operation_id uuid PRIMARY KEY REFERENCES swap_reviews(operation_id),
 review_hash bytea NOT NULL CHECK(octet_length(review_hash)=32),
 admitted_version bigint NOT NULL CHECK(admitted_version>=1),
 permit_digest bytea NOT NULL CHECK(octet_length(permit_digest)=32),
 signature_hash bytea NOT NULL CHECK(octet_length(signature_hash)=32),
 key_id text NOT NULL CHECK(key_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 encryption_nonce bytea NOT NULL CHECK(octet_length(encryption_nonce)=24),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) IN (80,81)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- This reservation prevents competing admitted signatures. History remains in
-- immutable rows. Reuse is allowed only after the old signature ceases to be valid
-- (the on-chain deadline is inclusive) and a fresh nonce observation is checked.
CREATE TABLE swap_permit_guards (
 chain_id bigint NOT NULL CHECK(chain_id>0),
 permit2 bytea NOT NULL CHECK(octet_length(permit2)=20),
 owner bytea NOT NULL CHECK(octet_length(owner)=20),
 token bytea NOT NULL CHECK(octet_length(token)=20),
 spender bytea NOT NULL CHECK(octet_length(spender)=20),
 nonce bigint NOT NULL CHECK(nonce BETWEEN 0 AND 281474976710655),
 operation_id uuid NOT NULL REFERENCES swap_reviews(operation_id),
 invalid_after timestamptz NOT NULL,
 PRIMARY KEY(chain_id,permit2,owner,token,spender,nonce)
);
CREATE TRIGGER immutable_swap_review BEFORE UPDATE OR DELETE ON swap_reviews
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
CREATE TRIGGER immutable_swap_permit BEFORE UPDATE OR DELETE ON swap_permit_signatures
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
