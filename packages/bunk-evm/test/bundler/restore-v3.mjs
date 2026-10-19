// Fresh process intentionally receives no ordinary owner signature, pending calls or journal.
// Only the repository's explicitly public test phrase is used here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicClient, http } from 'viem';
import { observeBunkEvmV3Account } from '../../../keyring/src/bunk-evm-observe.ts';
import { signBunkEvmV3SeedRecovery } from '../../../keyring/src/bunk-evm-v3-sign.ts';
import { mnemonicToSeed } from '../../../keyring/src/index.ts';

const { rpc, request } = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.match(rpc, /^http:\/\/127\.0\.0\.1:\d+$/);
const client = createPublicClient({ transport: http(rpc) });
const observation = await observeBunkEvmV3Account((r) => client.request(r), {
  ...request,
  now: () => Math.floor(Date.now() / 1000),
});
assert.equal(observation.status, 'deployed');
const { protocolVersion, account, accountIndex, epoch, recoveryCommitment } = observation.state;
const fixture = JSON.parse(
  fs.readFileSync(new URL('../../../keyring/src/fixtures/bunk-evm-v3.json', import.meta.url)),
);
const seed = await mnemonicToSeed(fixture.phrase);
try {
  const recovery = signBunkEvmV3SeedRecovery(seed, request.config, {
    protocolVersion,
    account,
    accountIndex,
    epoch,
    recoveryCommitment,
  });
  process.stdout.write(
    JSON.stringify({ ...recovery, observation }, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  );
} finally {
  seed.fill(0);
}
