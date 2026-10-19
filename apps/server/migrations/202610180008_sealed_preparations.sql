-- Existing public Earn evidence stays byte-for-byte unchanged. New swap signing
-- requests contain embedded bearer signatures and use the sealed representation.
-- Drain old API/workers before enabling sealed writes: old binaries cannot read them.
ALTER TABLE operation_preparations ALTER COLUMN canonical_json DROP NOT NULL;
ALTER TABLE operation_preparations
 ADD COLUMN public_json text,
 ADD COLUMN public_hash bytea,
 ADD COLUMN request_hash bytea,
 ADD COLUMN key_id text,
 ADD COLUMN encryption_nonce bytea,
 ADD COLUMN ciphertext bytea,
 ADD CONSTRAINT preparation_storage_shape CHECK (
  (canonical_json IS NOT NULL AND public_json IS NULL AND public_hash IS NULL
   AND request_hash IS NULL AND key_id IS NULL AND encryption_nonce IS NULL AND ciphertext IS NULL)
  OR
  (canonical_json IS NULL AND public_json IS NOT NULL AND public_hash IS NOT NULL
   AND request_hash IS NOT NULL AND key_id IS NOT NULL AND encryption_nonce IS NOT NULL
   AND ciphertext IS NOT NULL AND octet_length(public_json) BETWEEN 2 AND 2048
   AND octet_length(public_hash)=32 AND octet_length(request_hash)=32
   AND key_id ~ '^[A-Za-z0-9._:-]{1,64}$' AND octet_length(encryption_nonce)=24
   AND octet_length(ciphertext) BETWEEN 18 AND 262160)
 );

-- 64 KiB router calldata plus a bounded EIP-1559 envelope. Application validation
-- retains the old envelope bound for non-swap providers.
ALTER TABLE evm_signed_transactions DROP CONSTRAINT evm_signed_transactions_ciphertext_check;
ALTER TABLE evm_signed_transactions ADD CONSTRAINT evm_signed_transactions_ciphertext_check
 CHECK (octet_length(ciphertext) BETWEEN 17 AND 66576);
