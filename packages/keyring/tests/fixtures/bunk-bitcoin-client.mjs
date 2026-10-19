/** PUBLIC PHRASE / REGTEST ONLY. This signs fixtures, not application approvals. */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bunkPrivateKeyFor, deriveBunkOwner } from '../../src/bunk.ts';
import { assembleBunkBitcoinTransaction, prepareBunkBitcoinSpend } from '../../src/bunk-bitcoin.ts';
import {
  reserveObservedBunkBitcoinApproval,
  reviewBunkBitcoinApproval,
} from '../../src/bunk-bitcoin-approval.ts';
import { discoverBunkBitcoinUtxos } from '../../src/bunk-bitcoin-discovery.ts';
import { observeBunkBitcoinFeePolicy, selectBunkBitcoinFee } from '../../src/bunk-bitcoin-fees.ts';
import { discoverBunkBitcoinHistory } from '../../src/bunk-bitcoin-history.ts';
import {
  allocateBunkBitcoinAddress,
  claimBunkBitcoinApproval,
  initializeBunkBitcoinJournal,
  persistBunkBitcoinSignatures,
  readBunkBitcoinJournal,
  reserveBunkBitcoinApproval,
} from '../../src/bunk-bitcoin-journal.ts';
import {
  estimateBunkBitcoinChildFee,
  observeBunkBitcoinInputs,
} from '../../src/bunk-bitcoin-observe.ts';
import {
  observeBunkBitcoinApproval,
  submitBunkBitcoinApproval,
} from '../../src/bunk-bitcoin-submit.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../../src/bunk-evm-v2-store.ts';
import { deriveBunkJournalEncryptionKey } from '../../src/bunk-journal-key.ts';

export async function probe(request, rpc, sqlite) {
  if (request.network !== 'regtest') throw new Error('Public fixture requires regtest');
  const seed = mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const scope = { network: { family: 'bitcoin', network: 'regtest' }, accountIndex: 0 };
  const access = {
    rpc,
    now: () => Math.floor(Date.now() / 1000),
    maxTipAgeSeconds: 3600,
    minConfirmations: request.minConfirmations ?? 1,
  };
  let durable;
  const openStore = async () => {
    if (!sqlite) throw new Error('SQLite fixture adapter required');
    const raw = await createBunkJournalSqliteStore(sqlite),
      encryptionKey = deriveBunkJournalEncryptionKey(seed);
    try {
      durable = encryptedBunkJournalStore(raw, encryptionKey, (n) =>
        crypto.getRandomValues(new Uint8Array(n)),
      );
    } finally {
      encryptionKey.fill(0);
    }
    return durable;
  };
  try {
    if (request.kind === 'savedApproval') {
      const store = await openStore(),
        saved = request.saved;
      const input = {
        network: 'regtest',
        id: saved.id,
        digest: saved.digest,
        previousCheckpoint: request.previousCheckpoint,
        blockHint: request.blockHint,
        maximumFeeRateSatPerKvB: 20000n,
      };
      if (request.dropSendAcknowledgement)
        access.rpc = {
          async request(method, params) {
            const result = await rpc.request(method, params);
            if (method === 'sendrawtransaction')
              throw new Error('Fixture lost send acknowledgement');
            return result;
          },
        };
      return request.action === 'submit'
        ? await submitBunkBitcoinApproval(store, saved.key, seed, input, access)
        : await observeBunkBitcoinApproval(store, saved.key, seed, input, access);
    }
    if (request.kind === 'review') {
      // In-memory CAS only for this Core composition proof. The separate SQLite
      // runner proves durable storage; this fixture does not claim disk persistence.
      const rows = new Map();
      const store = {
        async read(key) {
          return rows.get(key) ?? null;
        },
        async compareAndSwap(key, revision, value) {
          if ((rows.get(key)?.revision ?? null) !== revision) return false;
          rows.set(key, { revision: revision === null ? 0 : revision + 1, value });
          return true;
        },
      };
      const { key } = await initializeBunkBitcoinJournal(store, seed, {
        network: 'regtest',
        accountIndex: 0,
        origin: 'new-wallet',
      });
      const id = (n) => n.toString(16).padStart(64, '0');
      for (let i = 0; i <= request.spend.changeIndex; i++)
        await allocateBunkBitcoinAddress(store, key, seed, {
          id: id(i + 1),
          expectedNextOwnerIndex: i,
          purpose: i === request.spend.changeIndex ? 'change' : 'receive',
        });
      const s = request.spend;
      const approvalRequest = {
        id: id(1000),
        changeAllocationId: id(s.changeIndex + 1),
        allowUnconfirmed: request.allowUnconfirmed ?? false,
        spend: {
          ...s,
          network: 'regtest',
          accountIndex: 0,
          utxos: s.utxos.map((u) => ({ ...u, satoshis: BigInt(u.satoshis) })),
          payments: s.payments.map((p) => ({ ...p, satoshis: BigInt(p.satoshis) })),
          feeRateSatPerKvB: BigInt(s.feeRateSatPerKvB),
          dustRelayFeeSatPerKvB: 3000n,
          maxFeeSat: BigInt(s.maxFeeSat),
        },
        feePolicy: {
          confirmationTarget: 6,
          mode: 'conservative',
          minimumRateSatPerKvB: 100n,
          maximumRateSatPerKvB: 20000n,
          fallbackRateSatPerKvB: BigInt(request.targetFeeRate ?? '1000'),
        },
      };
      const reviewed = await reviewBunkBitcoinApproval(store, key, seed, approvalRequest, access);
      const reserved = await reserveObservedBunkBitcoinApproval(
        store,
        key,
        seed,
        { ...approvalRequest, approvedReviewDigest: reviewed.reviewDigest },
        access,
      );
      return JSON.parse(
        JSON.stringify({ reviewed, reserved }, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
    }
    if (request.kind === 'fees') {
      const observation = await observeBunkBitcoinFeePolicy(
        {
          network: 'regtest',
          confirmationTarget: 6,
          mode: 'conservative',
        },
        access,
      );
      const b = request.budget;
      const selection =
        b &&
        selectBunkBitcoinFee(observation, {
          maxVbytes: b.maxVbytes,
          minimumRateSatPerKvB: BigInt(b.minimumRateSatPerKvB),
          maximumRateSatPerKvB: BigInt(b.maximumRateSatPerKvB),
          maxFeeSatoshis: BigInt(b.maxFeeSatoshis),
          fallbackRateSatPerKvB:
            b.fallbackRateSatPerKvB === undefined ? undefined : BigInt(b.fallbackRateSatPerKvB),
        });
      return JSON.parse(
        JSON.stringify({ observation, selection }, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
    }
    if (request.kind === 'owners')
      return request.indices.map((ownerIndex) => deriveBunkOwner(seed, { ...scope, ownerIndex }));
    if (request.kind === 'history') {
      const result = await discoverBunkBitcoinHistory(
        seed,
        {
          network: 'regtest',
          accountIndex: 0,
          startOwnerIndex: 0,
          count: 6,
          fromHeight: request.fromHeight ?? 0,
          blockCount: request.blockCount ?? 2016,
          previousCheckpoint: request.previousCheckpoint,
        },
        access,
      );
      return JSON.parse(
        JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
    }
    if (request.kind === 'observe') {
      const result = await observeBunkBitcoinInputs(
        seed,
        {
          network: 'regtest',
          accountIndex: 0,
          previousCheckpoint: request.previousCheckpoint,
          inputs: request.inputs.map((u) => ({ ...u, satoshis: BigInt(u.satoshis) })),
        },
        access,
      );
      return JSON.parse(
        JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
    }
    if (request.kind === 'discover') {
      const page = await discoverBunkBitcoinUtxos(
        seed,
        {
          network: 'regtest',
          accountIndex: 0,
          startOwnerIndex: 0,
          count: 6,
          previousCheckpoint: request.previousCheckpoint,
        },
        {
          rpc,
          now: () => Math.floor(Date.now() / 1000),
          maxTipAgeSeconds: 3600,
          minConfirmations: 1,
        },
      );
      return JSON.parse(JSON.stringify(page, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    }
    const input = {
      ...request,
      accountIndex: 0,
      utxos: request.utxos.map((u) => ({ ...u, satoshis: BigInt(u.satoshis) })),
      payments: request.payments.map((p) => ({ ...p, satoshis: BigInt(p.satoshis) })),
      feeRateSatPerKvB: BigInt(request.feeRateSatPerKvB),
      dustRelayFeeSatPerKvB: 3000n,
      maxFeeSat: BigInt(request.maxFeeSat),
    };
    let prepared = prepareBunkBitcoinSpend(seed, input);
    let cpfp;
    if (request.targetPackageRateSatPerKvB) {
      const observation = await observeBunkBitcoinInputs(
        seed,
        {
          network: 'regtest',
          accountIndex: 0,
          inputs: prepared.selected,
        },
        access,
      );
      if (!observation.inputs.every((u) => u.status === 'unconfirmed'))
        throw new Error('Fixture expects pending change');
      const budget = estimateBunkBitcoinChildFee({
        ancestors: observation.unconfirmedTransactions,
        childMaxVbytes: prepared.maxVbytes,
        targetRateSatPerKvB: BigInt(request.targetPackageRateSatPerKvB),
        minimumChildRateSatPerKvB: input.feeRateSatPerKvB,
        maxFeeSatoshis: input.maxFeeSat,
      });
      prepared = prepareBunkBitcoinSpend(seed, {
        ...input,
        feeRateSatPerKvB: budget.feeRateSatPerKvB,
      });
      if (
        prepared.maxVbytes !== budget.childMaxVbytes ||
        prepared.feeSatoshis !== budget.feeSatoshis
      )
        throw new Error('Recompute fee budget after selection or output shape changes');
      cpfp = { observation, budget };
    }
    let savedApproval;
    if (request.saveApproval) {
      const store = await openStore(),
        id = (n) => n.toString(16).padStart(64, '0');
      const { key } = await initializeBunkBitcoinJournal(store, seed, {
        network: 'regtest',
        accountIndex: 0,
        origin: 'new-wallet',
      });
      const journal = await readBunkBitcoinJournal(store, key, seed);
      for (let i = journal.nextOwnerIndex; i <= input.changeIndex; i++)
        await allocateBunkBitcoinAddress(store, key, seed, {
          id: id(i + 1),
          expectedNextOwnerIndex: i,
          purpose: i === input.changeIndex ? 'change' : 'receive',
        });
      const approval = await reserveBunkBitcoinApproval(store, key, seed, {
        id: id(request.saveApproval),
        changeAllocationId: id(input.changeIndex + 1),
        spend: {
          ...input,
          feeRateSatPerKvB: cpfp?.budget.feeRateSatPerKvB ?? input.feeRateSatPerKvB,
        },
      });
      await claimBunkBitcoinApproval(store, key, seed, {
        id: approval.id,
        digest: approval.digest,
      });
      savedApproval = { key, id: approval.id, digest: approval.digest };
    }
    const signatures = prepared.selected.map((u, i) => {
      const key = bunkPrivateKeyFor(seed, { ...scope, ownerIndex: u.ownerIndex });
      try {
        return bytesToHex(
          secp256k1.sign(hexToBytes(prepared.signatureDigests[i]), key, {
            prehash: false,
            lowS: true,
            format: 'der',
          }),
        );
      } finally {
        key.fill(0);
      }
    });
    const signed = assembleBunkBitcoinTransaction(prepared.transaction, signatures);
    if (savedApproval) {
      const persisted = await persistBunkBitcoinSignatures(durable, savedApproval.key, seed, {
        ...savedApproval,
        signatures,
      });
      if (persisted.signed.rawTransaction !== signed.rawTransaction)
        throw new Error('Persisted transaction changed');
    }
    return JSON.parse(
      JSON.stringify({ prepared, signed, cpfp, savedApproval }, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
  } finally {
    durable?.destroy();
    seed.fill(0);
  }
}
