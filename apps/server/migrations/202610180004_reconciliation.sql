-- Append meaningful chain-observation changes, not one history row per poll.
CREATE TABLE evm_reconciliation_batches (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES evm_submissions(operation_id),
 observations_json text NOT NULL CHECK (octet_length(observations_json) BETWEEN 2 AND 16384),
 observations_hash bytea NOT NULL CHECK (octet_length(observations_hash)=32),
 observed_at timestamptz NOT NULL,
 head_number numeric(20,0) NOT NULL CHECK (head_number>=0),
 head_hash bytea NOT NULL CHECK (octet_length(head_hash)=32),
 finalized_number numeric(20,0) NOT NULL CHECK (finalized_number>=0 AND finalized_number<=head_number),
 finalized_hash bytea NOT NULL CHECK (octet_length(finalized_hash)=32),
 UNIQUE(operation_id,id)
);
-- Refreshable latest verified checkpoint. Immutable batches retain meaningful
-- receipt/reorg/finality changes; polling the same state does not grow history.
CREATE TABLE evm_reconciliation_current (
 operation_id uuid PRIMARY KEY REFERENCES evm_submissions(operation_id),
 batch_id uuid NOT NULL,
 checked_at timestamptz NOT NULL,
 head_number numeric(20,0) NOT NULL CHECK (head_number>=0),
 head_hash bytea NOT NULL CHECK (octet_length(head_hash)=32),
 finalized_number numeric(20,0) NOT NULL CHECK (finalized_number>=0 AND finalized_number<=head_number),
 finalized_hash bytea NOT NULL CHECK (octet_length(finalized_hash)=32),
 FOREIGN KEY(operation_id,batch_id) REFERENCES evm_reconciliation_batches(operation_id,id)
);
CREATE TRIGGER immutable_evm_reconciliation BEFORE UPDATE OR DELETE ON evm_reconciliation_batches
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();
