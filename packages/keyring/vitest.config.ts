import { defineConfig } from 'vitest/config';

// Scrypt and BIP32/Merkle suites are CPU/memory intensive. Bound concurrency so
// running the workspace's other packages does not multiply KDF memory/workers.
export default defineConfig({ test: { maxWorkers: 2 } });
