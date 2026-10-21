-- Across is removed; bridging is NEAR Intents. 202610180011 also introduced the
-- generic 'bridging' state and bridge_status_watches.stopped_at, so it stays applied
-- and this migration only drops what was Across-specific. Apply explicitly after old
-- workers drain.

-- Dropping the table also drops its immutable_across_settlement and
-- atomic_across_settlement triggers.
DROP TABLE across_settlements;
DROP FUNCTION require_atomic_across_settlement();

-- No verified-delivery writer remains, so a bridge operation cannot be marked
-- succeeded until a settlement verifier exists. Identity and source-final rules stay.
CREATE OR REPLACE FUNCTION require_bridge_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.action='bridge' AND (
  ROW(NEW.id,NEW.action,NEW.user_id,NEW.wallet_id,NEW.intent_hash) IS DISTINCT FROM ROW(OLD.id,OLD.action,OLD.user_id,OLD.wallet_id,OLD.intent_hash)
  OR (OLD.state='succeeded' AND ROW(NEW.state,NEW.version) IS DISTINCT FROM ROW(OLD.state,OLD.version))
 ) THEN RAISE EXCEPTION 'bridge identity or settled outcome is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.action='bridge' AND OLD.state='bridging'
   AND NEW.state<>'succeeded'
   AND ROW(NEW.state,NEW.version) IS DISTINCT FROM ROW(OLD.state,OLD.version) THEN
  RAISE EXCEPTION 'source-final bridge remains pending until verified settlement' USING ERRCODE='23514';
 END IF;
 IF NEW.action='bridge' AND NEW.state='succeeded' THEN
  RAISE EXCEPTION 'bridge success requires verified delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_bridge_poll_stop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS DISTINCT FROM OLD.stopped_at THEN
  RAISE EXCEPTION 'verified bridge outcome is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.stopped_at IS NOT NULL THEN
  RAISE EXCEPTION 'stopping bridge polling requires verified delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- Advisory status polling is Relay only.
ALTER TABLE bridge_status_watches DROP CONSTRAINT bridge_status_watches_provider_check;
ALTER TABLE bridge_status_watches ADD CONSTRAINT bridge_status_watches_provider_check
 CHECK (provider='relay');
