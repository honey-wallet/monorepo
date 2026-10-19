-- Source finality is not bridge delivery. Apply explicitly after old workers drain.
ALTER TABLE operations DROP CONSTRAINT operations_state_check;
ALTER TABLE operations ADD CONSTRAINT operations_state_check CHECK (state IN
 ('created','awaiting_permit','building_swap','awaiting_signature','signed',
  'submitted','confirming','bridging','succeeded','failed','unknown'));
ALTER TABLE operations ADD CONSTRAINT bridging_action_check CHECK(state <> 'bridging' OR action='bridge');
ALTER TABLE bridge_status_watches ADD COLUMN stopped_at timestamptz;
DROP INDEX bridge_status_due;
CREATE INDEX bridge_status_due ON bridge_status_watches(provider,next_poll_at,operation_id) WHERE stopped_at IS NULL;

-- One immutable verified financial outcome per operation. JSON is an audit record,
-- never deserialized into the private verified-proof type for a subsequent write.
CREATE TABLE across_settlements (
 operation_id uuid PRIMARY KEY REFERENCES bridge_status_watches(operation_id),
 operation_version bigint NOT NULL CHECK(operation_version>0),
 evidence_version smallint NOT NULL CHECK(evidence_version=1),
 source_transaction_id uuid NOT NULL UNIQUE REFERENCES evm_signed_transactions(id),
 completed_job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
 completed_lease_token uuid NOT NULL,
 proof_json text NOT NULL CHECK(octet_length(proof_json) BETWEEN 2 AND 16384),
 proof_hash bytea NOT NULL CHECK(octet_length(proof_hash)=32),
 source_chain_id bigint NOT NULL CHECK(source_chain_id>0),
 destination_chain_id bigint NOT NULL CHECK(destination_chain_id>0 AND destination_chain_id<>source_chain_id),
 source_block_number numeric(20,0) NOT NULL CHECK(source_block_number>=0),
 source_block_hash bytea NOT NULL CHECK(octet_length(source_block_hash)=32),
 source_finalized_number numeric(20,0) NOT NULL CHECK(source_finalized_number>=source_block_number),
 source_finalized_hash bytea NOT NULL CHECK(octet_length(source_finalized_hash)=32),
 destination_transaction_hash bytea NOT NULL CHECK(octet_length(destination_transaction_hash)=32),
 destination_block_number numeric(20,0) NOT NULL CHECK(destination_block_number>=0),
 destination_block_hash bytea NOT NULL CHECK(octet_length(destination_block_hash)=32),
 destination_finalized_number numeric(20,0) NOT NULL CHECK(destination_finalized_number>=destination_block_number),
 destination_finalized_hash bytea NOT NULL CHECK(octet_length(destination_finalized_hash)=32),
 checked_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_across_settlement BEFORE UPDATE OR DELETE ON across_settlements
 FOR EACH ROW EXECUTE FUNCTION reject_preparation_evidence_mutation();

CREATE FUNCTION require_bridge_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.action='bridge' AND (
  ROW(NEW.id,NEW.action,NEW.user_id,NEW.wallet_id,NEW.intent_hash) IS DISTINCT FROM ROW(OLD.id,OLD.action,OLD.user_id,OLD.wallet_id,OLD.intent_hash)
  OR (OLD.state='succeeded' AND ROW(NEW.state,NEW.version) IS DISTINCT FROM ROW(OLD.state,OLD.version))
 ) THEN RAISE EXCEPTION 'bridge identity or settled outcome is immutable' USING ERRCODE='23514'; END IF;
 -- Once the source deposit is final, generic failure/unknown transitions would
 -- misreport a transfer whose destination may still be executing. Only the
 -- settlement writer may move this state to succeeded, and that path is checked
 -- below against the immutable verified settlement row.
 IF TG_OP='UPDATE' AND OLD.action='bridge' AND OLD.state='bridging'
   AND NEW.state<>'succeeded'
   AND ROW(NEW.state,NEW.version) IS DISTINCT FROM ROW(OLD.state,OLD.version) THEN
  RAISE EXCEPTION 'source-final bridge remains pending until verified settlement' USING ERRCODE='23514';
 END IF;
 IF NEW.action='bridge' AND NEW.state='succeeded' THEN
  IF TG_OP='INSERT' OR OLD.state NOT IN ('bridging','succeeded') OR NOT EXISTS(
   SELECT 1 FROM across_settlements s WHERE s.operation_id=NEW.id AND s.operation_version=NEW.version
  ) THEN RAISE EXCEPTION 'bridge success requires verified delivery' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bridge_delivery_required BEFORE INSERT OR UPDATE ON operations
 FOR EACH ROW EXECUTE FUNCTION require_bridge_delivery();

CREATE FUNCTION protect_bridge_poll_stop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS DISTINCT FROM OLD.stopped_at THEN
  RAISE EXCEPTION 'verified bridge outcome is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.stopped_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM across_settlements s WHERE s.operation_id=NEW.operation_id) THEN
  RAISE EXCEPTION 'stopping bridge polling requires verified delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bridge_poll_stop_required BEFORE UPDATE ON bridge_status_watches
 FOR EACH ROW EXECUTE FUNCTION protect_bridge_poll_stop();

-- Prevent a partial financial commit even if a future caller forgets one write.
CREATE FUNCTION require_atomic_across_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM operations o JOIN bridge_status_watches w ON w.operation_id=o.id
   JOIN jobs j ON j.id=NEW.completed_job_id
   WHERE o.id=NEW.operation_id AND o.action='bridge' AND o.state='succeeded' AND o.version=NEW.operation_version
    AND w.provider='across' AND w.source_transaction_id=NEW.source_transaction_id AND w.stopped_at IS NOT NULL
    AND j.operation_id=o.id AND j.operation_version=NEW.operation_version-1 AND j.state='done') THEN
  RAISE EXCEPTION 'incomplete Across settlement transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER atomic_across_settlement AFTER INSERT ON across_settlements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_atomic_across_settlement();
