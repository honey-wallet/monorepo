-- Generalize the existing immutable signing evidence without copying or rewriting
-- any canonical payload/hash. Deploy with API/workers drained: old binaries use
-- the previous table name. PostgreSQL takes a brief metadata lock for these renames.
ALTER TABLE aave_signing_requests RENAME TO evm_signing_requests;
ALTER TRIGGER immutable_aave_signing ON evm_signing_requests RENAME TO immutable_evm_signing;
ALTER INDEX aave_intent_service RENAME TO earn_intent_service;
