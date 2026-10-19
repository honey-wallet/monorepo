-- Provider hints are independent from financial operation state and receipt proof.
-- Apply explicitly. Existing signing readers remain unchanged.
CREATE TABLE bridge_status_watches (
 operation_id uuid PRIMARY KEY REFERENCES operations(id),
 source_transaction_id uuid NOT NULL UNIQUE REFERENCES evm_signed_transactions(id),
 provider text NOT NULL CHECK (provider IN ('relay','across')),
 binding_json text NOT NULL CHECK (octet_length(binding_json) BETWEEN 2 AND 4096),
 binding_hash bytea NOT NULL CHECK (octet_length(binding_hash)=32),
 poll_version bigint NOT NULL DEFAULT 0 CHECK (poll_version>=0),
 next_poll_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,
 lease_until timestamptz,
 observation_json text CHECK (octet_length(observation_json)<=65536),
 observation_hash bytea CHECK (octet_length(observation_hash)=32),
 observed_at timestamptz,
 last_error_code text CHECK (last_error_code IN ('invalid','busy','cooldown','unavailable','rejected','invalid_response','ambiguous','unsupported_route')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK ((observation_json IS NULL)=(observation_hash IS NULL)),
 CHECK ((observation_json IS NULL)=(observed_at IS NULL))
);
CREATE INDEX bridge_status_due ON bridge_status_watches(provider,next_poll_at,operation_id);
CREATE FUNCTION protect_bridge_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.operation_id,NEW.source_transaction_id,NEW.provider,NEW.binding_json,NEW.binding_hash,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.operation_id,OLD.source_transaction_id,OLD.provider,OLD.binding_json,OLD.binding_hash,OLD.created_at) THEN
  RAISE EXCEPTION 'immutable bridge binding';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_bridge_binding BEFORE UPDATE OR DELETE ON bridge_status_watches
 FOR EACH ROW EXECUTE FUNCTION protect_bridge_binding();
