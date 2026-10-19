// Public deterministic test material; no wallet/network/environment access.
import { writeFileSync } from 'node:fs';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 32);
const context = [
  'honey.evm.signed.v1',
  '226d9165-1bde-42a7-a17c-7dab0c03237c',
  'a'.repeat(64),
  1,
  1,
  '11'.repeat(20),
  '9007199254740993',
  '22'.repeat(32),
  'public-test-key',
];
const aad = new TextEncoder().encode(JSON.stringify(context));
const plaintext = new TextEncoder().encode('synthetic broadcastable authorization; no real funds');
const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
const hex = (bytes) => Buffer.from(bytes).toString('hex');
writeFileSync(
  new URL('../../../apps/server/tests/fixtures/submission-encryption-noble.json', import.meta.url),
  `${JSON.stringify({ generator: '@noble/ciphers 2.4.0 XChaCha20Poly1305', key: hex(key), nonce: hex(nonce), aad: hex(aad), plaintext: hex(plaintext), ciphertext: hex(ciphertext) }, null, 2)}\n`,
);
key.fill(0);
console.log('Wrote offline cross-language encryption fixture.');
