-- Signed authorization is durable before dispatch. Never migrate automatically.
ALTER TABLE operations DROP CONSTRAINT operations_state_check;
ALTER TABLE operations ADD CONSTRAINT operations_state_check CHECK (state IN
 ('created','awaiting_signature','signed','submitted','confirming','succeeded','failed','unknown'));

CREATE TABLE evm_submissions (
 operation_id uuid PRIMARY KEY REFERENCES operation_preparations(operation_id),
 wallet_id uuid NOT NULL REFERENCES wallet_memberships(id),
 chain_id bigint NOT NULL CHECK (chain_id > 0),
 signer bytea NOT NULL CHECK (octet_length(signer)=20),
 plan_hash bytea NOT NULL CHECK (octet_length(plan_hash)=32),
 first_nonce numeric(20,0) NOT NULL CHECK (first_nonce>=0 AND first_nonce<18446744073709551615),
 step_count smallint NOT NULL CHECK (step_count BETWEEN 1 AND 8),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operation_id,chain_id,signer)
);
-- No TTL: a signed or ambiguous operation cannot silently free its nonces.
-- A later evidence-aware finality/cancellation method must release this guard.
CREATE TABLE evm_wallet_guards (
 wallet_id uuid PRIMARY KEY REFERENCES wallet_memberships(id),
 operation_id uuid NOT NULL UNIQUE REFERENCES evm_submissions(operation_id)
);
CREATE TABLE evm_signed_transactions (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL,
 step smallint NOT NULL CHECK (step BETWEEN 0 AND 7),
 chain_id bigint NOT NULL,
 signer bytea NOT NULL,
 nonce numeric(20,0) NOT NULL CHECK (nonce>=0 AND nonce<18446744073709551615),
 tx_hash bytea NOT NULL CHECK (octet_length(tx_hash)=32),
 key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce)=24),
 ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 8208),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(operation_id,chain_id,signer) REFERENCES evm_submissions(operation_id,chain_id,signer),
 UNIQUE(operation_id,step), UNIQUE(chain_id,signer,nonce), UNIQUE(chain_id,tx_hash)
);
-- One initial dispatch per transaction. Fee replacement/resend requires a separate
-- reviewed protocol; uniqueness intentionally refuses a generic retry loop.
CREATE TABLE evm_dispatch_attempts (
 id uuid PRIMARY KEY,
 transaction_id uuid NOT NULL UNIQUE REFERENCES evm_signed_transactions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE evm_dispatch_observations (
 attempt_id uuid PRIMARY KEY REFERENCES evm_dispatch_attempts(id),
 outcome text NOT NULL CHECK (outcome IN ('acknowledged','unknown')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_evm_submission BEFORE UPDATE OR DELETE ON evm_submissions
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
CREATE TRIGGER immutable_evm_signed_transaction BEFORE UPDATE OR DELETE ON evm_signed_transactions
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
CREATE TRIGGER immutable_evm_dispatch BEFORE UPDATE OR DELETE ON evm_dispatch_attempts
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
CREATE TRIGGER immutable_evm_observation BEFORE UPDATE OR DELETE ON evm_dispatch_observations
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
