import type { Answer, Approval } from '@honey-wallet/extension/protocol';
import {
  evmNetwork,
  parseTypedData,
  reviewSolanaTransaction,
  SOLANA_MAINNET,
  signEvmMessage,
  signEvmTransaction,
  signEvmTypedData,
  signSolanaMessage,
  signSolanaTransaction,
} from '@honey-wallet/keyring';
import { createPublicClient, type Hex, http, type TransactionSerializable } from 'viem';
import { requestJsonRpc } from '@/lib/json-rpc';
import { privateKeyOf } from '@/lib/vault';

/**
 * What runs after you approve a website's request in Honey for Chrome: sign with the
 * wallet's key (read from the vault, used, then wiped), and for "send" fill in the nonce,
 * gas and fees and broadcast. Also reads what a request contains, to show it first.
 */

export type EvmTx = { from: string; to: string | null; value: Hex; data: Hex; gas?: Hex };

// Reading requests

/** A message as text when it is text, otherwise its hex. */
export function readableMessage(bytes: Uint8Array): { text: string; isText: boolean } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Show layout-changing and invisible format controls explicitly. The signed bytes
    // remain untouched; only this review string is escaped.
    const review = text.replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security display filter
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: intentional independent code point escaping
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu,
      (char) => `[U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}]`,
    );
    return { text: review, isText: true };
  } catch {
    // Not UTF-8.
  }
  return {
    text: `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`,
    isText: false,
  };
}

export function evmMessageBytes(message: string): Uint8Array {
  if (/^0x([0-9a-f]{2})*$/i.test(message)) {
    const hex = message.slice(2);
    return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
      Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );
  }
  return new TextEncoder().encode(message);
}

/**
 * Sign-In with Ethereum (EIP-4361): the domain it's for, so a sign-in meant for another
 * site can be called out. Null when the message isn't a SIWE message.
 */
export function siweDomain(text: string): string | null {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:/i.exec(
      text,
    );
  return match?.[1] ?? null;
}

export const fromBase64 = (data: string) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('Bad base64 data');
  }
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
};
export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The fee payer and size of a Solana transaction, or null if it can't be read. */
export function solanaSummary(base64: string) {
  try {
    const bytes = fromBase64(base64);
    const read = reviewSolanaTransaction(bytes);
    return {
      feePayer: read.feePayer,
      signers: read.signers,
      bytes: bytes.length,
      version: read.version,
      instructions: read.reviewedInstructions,
      reviewable: read.reviewable,
    };
  } catch {
    return null;
  }
}

export type EvmCallReview = {
  reviewable: boolean;
  label: string;
  rows: [string, string][];
  warning?: string;
  reason?: string;
};

/** Decode the deliberately small standard-call allowlist shown in dApp approvals. */
export function inspectEvmCall(data: Hex, to: string | null): EvmCallReview {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data)) {
    return {
      reviewable: false,
      label: 'Malformed contract call',
      rows: [],
      reason: 'Invalid calldata.',
    };
  }
  if (data === '0x') {
    if (!to) {
      return {
        reviewable: false,
        label: 'Contract deployment',
        rows: [],
        reason: 'Contract creation code cannot be reviewed safely yet.',
      };
    }
    return {
      reviewable: true,
      label: 'Native asset transfer or empty call',
      rows: [],
      warning: 'The destination may be a contract whose fallback behavior Honey has not inspected.',
    };
  }
  if (data.length < 10) {
    return {
      reviewable: false,
      label: 'Unknown contract call',
      rows: [],
      reason: 'Calldata is too short to identify.',
    };
  }
  const selector = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);
  const word = (index: number) => body.slice(index * 64, (index + 1) * 64);
  const address = (index: number) => {
    const value = word(index);
    if (value.length !== 64 || !/^0{24}[0-9a-f]{40}$/i.test(value)) return null;
    return `0x${value.slice(24)}`;
  };
  const amount = (index: number) => {
    const value = word(index);
    return value.length === 64 ? BigInt(`0x${value}`).toString() : null;
  };
  const exactWords = (count: number) => body.length === count * 64;
  const unsupported = (label: string, rows: [string, string][], reason: string): EvmCallReview => ({
    reviewable: false,
    label,
    rows,
    reason,
  });
  if (selector === '0xa9059cbb') {
    const recipient = exactWords(2) ? address(0) : null;
    const units = exactWords(2) ? amount(1) : null;
    if (!recipient || units === null)
      return unsupported('ERC-20 transfer', [], 'Malformed transfer arguments.');
    return {
      reviewable: true,
      label: 'ERC-20 transfer',
      rows: [
        ['Recipient', recipient],
        ['Raw token units', units],
      ],
      warning:
        'Honey recognizes the standard ERC-20 selector, but does not verify this contract’s bytecode or token decimals.',
    };
  }
  if (selector === '0x23b872dd') {
    const from = exactWords(3) ? address(0) : null;
    const recipient = exactWords(3) ? address(1) : null;
    const units = exactWords(3) ? amount(2) : null;
    return unsupported(
      'Ambiguous transferFrom',
      from && recipient && units !== null
        ? [
            ['From', from],
            ['To', recipient],
            ['Raw amount or token ID', units],
          ]
        : [],
      'This selector can mean a fungible-token amount or an NFT token ID; Honey cannot identify which effect this contract implements.',
    );
  }
  if (selector === '0x095ea7b3') {
    const spender = exactWords(2) ? address(0) : null;
    const units = exactWords(2) ? amount(1) : null;
    return unsupported(
      'Ambiguous approval',
      spender && units !== null
        ? [
            ['Spender', spender],
            ['Raw amount or token ID', units],
          ]
        : [],
      'This selector can authorize fungible-token spending or approve one NFT; Honey cannot identify which effect this contract implements.',
    );
  }
  if (selector === '0x39509351' || selector === '0xa457c2d7') {
    const spender = exactWords(2) ? address(0) : null;
    const units = exactWords(2) ? amount(1) : null;
    if (!spender || units === null)
      return unsupported('Allowance change', [], 'Malformed allowance arguments.');
    return {
      reviewable: true,
      label: selector === '0x39509351' ? 'Increase token allowance' : 'Decrease token allowance',
      rows: [
        ['Spender', spender],
        ['Raw token units', units],
      ],
      warning:
        'Honey recognizes the standard selector, but does not verify this contract’s bytecode or token decimals.',
    };
  }
  if (selector === '0xa22cb465') {
    const operator = exactWords(2) ? address(0) : null;
    const approved = exactWords(2) ? word(1) : '';
    if (!operator || !/^(?:0{63}0|0{63}1)$/i.test(approved)) {
      return unsupported('Operator approval', [], 'Malformed operator approval arguments.');
    }
    return {
      reviewable: true,
      label: approved.endsWith('1')
        ? 'Approve all assets for operator'
        : 'Revoke operator approval',
      rows: [['Operator', operator]],
      warning:
        'This standard selector may grant control over every NFT managed by the contract; the contract implementation is not verified.',
    };
  }
  if (selector === '0x42842e0e') {
    const from = exactWords(3) ? address(0) : null;
    const recipient = exactWords(3) ? address(1) : null;
    const tokenId = exactWords(3) ? amount(2) : null;
    if (!from || !recipient || tokenId === null)
      return unsupported('NFT transfer', [], 'Malformed NFT transfer arguments.');
    return {
      reviewable: true,
      label: 'ERC-721 transfer',
      rows: [
        ['From', from],
        ['Recipient', recipient],
        ['Token ID', tokenId],
      ],
      warning:
        'Honey recognizes the standard ERC-721 selector, but does not verify this contract’s bytecode.',
    };
  }
  return unsupported(
    `Unknown contract call · ${selector}`,
    [['Calldata', data]],
    'Honey cannot safely decode this contract call, so signing is blocked.',
  );
}

/** Typed-data messages that let someone else move your tokens. */
export const isPermit = (primaryType: string) =>
  /^Permit(Single|Batch|TransferFrom|BatchTransferFrom|WitnessTransferFrom)?$/.test(primaryType);

const DOMAIN_FIELDS = ['name', 'version', 'chainId', 'verifyingContract', 'salt'] as const;
type TypedField = { name: string; type: string };

/** The full domain separator input and message fields as viem will hash them. */
export function typedDataReview(json: string) {
  const typed = parseTypedData(json);
  const raw = JSON.parse(json) as {
    domain?: Record<string, unknown> | null;
    types?: Record<string, unknown>;
  };
  const types = typed.types as unknown as Record<string, readonly TypedField[]>;
  const domain = (typed.domain ?? {}) as Record<string, unknown>;
  const explicit = Object.hasOwn(types, 'EIP712Domain');
  const domainType = explicit
    ? types.EIP712Domain
    : DOMAIN_FIELDS.flatMap((name): TypedField[] => {
        const value = domain[name];
        const included =
          (name === 'name' && typeof value === 'string') ||
          (name === 'version' && Boolean(value)) ||
          (name === 'chainId' && (typeof value === 'number' || typeof value === 'bigint')) ||
          ((name === 'verifyingContract' || name === 'salt') && Boolean(value));
        if (!included) return [];
        return [
          {
            name,
            type:
              name === 'chainId'
                ? 'uint256'
                : name === 'verifyingContract'
                  ? 'address'
                  : name === 'salt'
                    ? 'bytes32'
                    : 'string',
          },
        ];
      });
  const domainShape = Array.isArray(domainType);
  const domainRows =
    explicit && domainShape
      ? typedRows({ EIP712Domain: domainType }, 'EIP712Domain', domain).rows
      : [];
  const domainFields = domainShape ? domainType.map((field) => field.name) : [];
  const unboundDomainFields = Object.keys(domain).filter((field) => !domainFields.includes(field));
  if (!explicit && domainShape) {
    for (const field of DOMAIN_FIELDS) {
      const bound = domainFields.includes(field);
      const provided = Object.hasOwn(domain, field);
      const value = bound
        ? displayTypedValue(domain[field])
        : provided
          ? `${displayTypedValue(domain[field])} (provided but not signed)`
          : '(not set; not signed)';
      domainRows.push([field, value]);
    }
  } else if (domainShape) {
    for (const field of DOMAIN_FIELDS) {
      if (domainFields.includes(field)) continue;
      domainRows.push([
        field,
        Object.hasOwn(domain, field)
          ? `${displayTypedValue(domain[field])} (provided but not signed)`
          : '(not included in signature)',
      ]);
    }
  }
  for (const field of unboundDomainFields) {
    if (!domainRows.some(([name]) => name === field)) {
      domainRows.push([field, `${displayTypedValue(domain[field])} (not signed)`]);
    }
  }
  const message = typedRows(
    types,
    String(typed.primaryType),
    (typed.message ?? {}) as Record<string, unknown>,
  );
  const malformedDomain =
    !domainShape ||
    (raw.domain !== undefined &&
      raw.domain !== null &&
      (typeof raw.domain !== 'object' || Array.isArray(raw.domain)));
  const encodedChainId = domainFields.includes('chainId') ? domain.chainId : undefined;
  const chainId =
    (typeof encodedChainId === 'number' || typeof encodedChainId === 'bigint') &&
    (domainType as readonly TypedField[]).some(
      (field) => field.name === 'chainId' && /^uint\d*$/.test(field.type),
    )
      ? Number(encodedChainId)
      : undefined;
  return {
    typed,
    primaryTypeLabel: escapeReviewText(String(typed.primaryType)),
    domainRows: domainRows.map(([key, value]) => [escapeReviewText(key), value]),
    messageRows: message.rows,
    messageComplete: message.complete,
    domainComplete:
      !malformedDomain &&
      unboundDomainFields.length === 0 &&
      (explicit ? typedRows({ EIP712Domain: domainType }, 'EIP712Domain', domain).complete : true),
    complete:
      !malformedDomain &&
      unboundDomainFields.length === 0 &&
      message.complete &&
      (explicit ? typedRows({ EIP712Domain: domainType }, 'EIP712Domain', domain).complete : true),
    unboundDomainFields,
    chainId,
    hasChainBinding: chainId !== undefined,
  };
}

function displayTypedValue(value: unknown): string {
  if (typeof value === 'string') return escapeReviewText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || value === null) return '(missing)';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function escapeReviewText(value: string): string {
  // Keep the typed-data payload intact for signing; escape format/control characters
  // only in the human-readable approval view.
  return value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security display filter
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: intentional independent code point escaping
    /[\u0000-\u001F\u007F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu,
    (char) => `[U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}]`,
  );
}

/** Shared fail-closed review gate used both by the screen and the signing boundary. */
export function approvalReviewError(approval: Approval): string | null {
  try {
    const params = approval.params as Record<string, unknown>;
    if (approval.kind === 'evmSend') {
      const call = inspectEvmCall((params.tx as EvmTx).data, (params.tx as EvmTx).to);
      return call.reviewable
        ? null
        : (call.reason ?? 'Honey cannot safely decode this contract call.');
    }
    if (approval.kind === 'evmTypedData') {
      return typedDataReview(params.data as string).complete
        ? null
        : 'This typed-data request has fields Honey cannot show exactly as signed. Signing is blocked.';
    }
    if (approval.kind === 'solanaSignTransaction' || approval.kind === 'solanaSend') {
      const review = reviewSolanaTransaction(fromBase64(params.transaction as string));
      return review.reviewable
        ? null
        : 'Honey can’t safely decode every Solana instruction; signing is blocked.';
    }
    return null;
  } catch {
    return 'Honey could not safely read this request. Signing is blocked.';
  }
}

// EVM sending

const clientFor = (chainId: number) => {
  const network = evmNetwork(chainId);
  if (!network) throw new Error('Honey doesn’t support this network yet');
  return { network, client: createPublicClient({ transport: http(network.rpc) }) };
};

/**
 * Fills in what the site left out: nonce, gas (the node's estimate plus 20%) and fees
 * (EIP-1559 where the network has it). Throws the node's reason when it would fail.
 */
export async function prepareEvmSend(tx: EvmTx, chainId: number) {
  const { client } = clientFor(chainId);
  const call = {
    account: tx.from as Hex,
    to: (tx.to ?? undefined) as Hex | undefined,
    value: BigInt(tx.value),
    data: tx.data,
  };
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: tx.from as Hex, blockTag: 'pending' }),
    tx.gas
      ? Promise.resolve(BigInt(tx.gas))
      : client.estimateGas(call).then((g) => (g * 12n) / 10n),
    client
      .estimateFeesPerGas()
      .then((f) => ({ eip1559: true as const, ...f }))
      .catch(async () => ({ eip1559: false as const, gasPrice: await client.getGasPrice() })),
  ]);
  const base = { chainId, nonce, to: call.to ?? null, value: call.value, data: tx.data, gas };
  const unsigned: TransactionSerializable =
    fees.eip1559 && 'maxFeePerGas' in fees && fees.maxFeePerGas !== undefined
      ? {
          ...base,
          type: 'eip1559',
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      : { ...base, type: 'legacy', gasPrice: 'gasPrice' in fees ? fees.gasPrice : undefined };
  const perGas =
    unsigned.type === 'eip1559' ? (unsigned.maxFeePerGas ?? 0n) : (unsigned.gasPrice ?? 0n);
  return { unsigned, maxFee: gas * perGas };
}

export type PreparedEvmSend = Awaited<ReturnType<typeof prepareEvmSend>>;

export type EvmSendPreparation =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; prepared: PreparedEvmSend };

function preparedSendMatches(tx: EvmTx, chainId: number, prepared: PreparedEvmSend) {
  const unsigned = prepared.unsigned;
  const feePerGas = unsigned.type === 'eip1559' ? unsigned.maxFeePerGas : unsigned.gasPrice;
  return (
    unsigned.chainId === chainId &&
    (unsigned.to ?? null) === tx.to &&
    (unsigned.value ?? 0n) === BigInt(tx.value) &&
    (unsigned.data ?? '0x').toLowerCase() === tx.data.toLowerCase() &&
    (tx.gas === undefined || unsigned.gas === BigInt(tx.gas)) &&
    unsigned.gas !== undefined &&
    feePerGas !== undefined &&
    prepared.maxFee === unsigned.gas * feePerGas
  );
}

/** A node's error, short enough to show. */
export function reasonOf(error: unknown) {
  const text =
    (error as { shortMessage?: string })?.shortMessage ??
    (error instanceof Error ? error.message : String(error));
  return text.split('\n')[0]?.slice(0, 160) ?? 'Unknown error';
}

export function requestSolanaRpc(
  method: string,
  params: unknown[],
  fetcher: typeof fetch = fetch,
  timeoutMs = 15_000,
) {
  return requestJsonRpc(SOLANA_MAINNET.rpc, method, params, {
    fetcher,
    timeoutMs,
    // A Solana send response is a transaction signature or a small RPC error object.
    maxResponseBytes: 16 * 1024,
  });
}

// Answering

/**
 * Signs (and for "send", broadcasts) what the site asked for with `walletId`'s key.
 * Returns the answer for the site; throws when signing or sending failed.
 */
export async function performApproval(
  approval: Approval,
  walletId: string,
  preparedEvmSend?: PreparedEvmSend,
): Promise<Answer> {
  const id = approval.id;
  const params = approval.params as Record<string, unknown>;
  const chain = approval.kind.startsWith('solana') ? 'solana' : 'evm';
  if (approval.kind === 'switchChain') return { id, result: null };
  const reviewError = approvalReviewError(approval);
  if (reviewError) throw new Error(reviewError);
  let reviewedEvmSend: PreparedEvmSend | undefined;
  if (approval.kind === 'evmSend') {
    const { chainId, tx } = params as { chainId: number; tx: EvmTx };
    if (!preparedEvmSend || !preparedSendMatches(tx, chainId, preparedEvmSend)) {
      throw new Error('Transaction details or fee estimate changed. Review the transaction again.');
    }
    reviewedEvmSend = preparedEvmSend;
  }
  const key = await privateKeyOf(walletId, chain);
  try {
    switch (approval.kind) {
      case 'evmSign':
        return { id, result: await signEvmMessage(key, params.message as string) };
      case 'evmTypedData': {
        return { id, result: await signEvmTypedData(key, params.data as string) };
      }
      case 'evmSend': {
        const chainId = params.chainId as number;
        if (!reviewedEvmSend) throw new Error('Transaction review is missing.');
        const { client } = clientFor(chainId);
        // The exact nonce, gas limit, and fee caps shown in the approval screen are
        // the values signed. Never silently refresh them after the user's consent.
        const signed = await signEvmTransaction(key, reviewedEvmSend.unsigned);
        return { id, result: await client.sendRawTransaction({ serializedTransaction: signed }) };
      }
      case 'solanaSignMessage': {
        const bytes = fromBase64(params.message as string);
        // The worker refuses non-text already; never sign bytes that could be a transaction.
        if (!readableMessage(bytes).isText) throw new Error('Honey only signs readable text');
        const signature = signSolanaMessage(key, bytes);
        return { id, result: { signature: toBase64(signature) } };
      }
      case 'solanaSignTransaction': {
        const transaction = fromBase64(params.transaction as string);
        const signed = signSolanaTransaction(key, transaction);
        return { id, result: { signedTransaction: toBase64(signed) } };
      }
      case 'solanaSend': {
        const transaction = fromBase64(params.transaction as string);
        const signed = signSolanaTransaction(key, transaction);
        const signature = await requestSolanaRpc('sendTransaction', [
          toBase64(signed),
          { encoding: 'base64', preflightCommitment: 'confirmed' },
        ]);
        return { id, result: { signature } };
      }
      default:
        throw new Error('Nothing to sign');
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Every field EIP-712 encodes, in order, by walking the declared types from the primary
 * type, so what's shown is exactly what's signed (keys a site adds outside the types are
 * ignored by the signature, and so they aren't shown either).
 */
/** The most rows a typed-data request may expand to; past it, Honey won't show or sign it. */
export const TYPED_ROW_LIMIT = 300;

export function typedRows(
  types: Record<string, readonly TypedField[]>,
  primaryType: string,
  message: Record<string, unknown>,
): { rows: [string, string][]; complete: boolean } {
  const rows: [string, string][] = [];
  // One budget for the whole walk: types that refer to each other can't make it explode.
  // `complete` is false when anything couldn't be shown exactly as it would be signed (too
  // big, a missing field, the wrong shape); Honey then refuses to sign.
  let visits = 0;
  let truncated = false;
  let malformed = false;
  const walk = (type: string, value: unknown, path: string, depth: number) => {
    if (truncated) return;
    if (++visits > TYPED_ROW_LIMIT * 2 || rows.length >= TYPED_ROW_LIMIT || depth > 8) {
      truncated = true;
      return;
    }
    const array = /^(.*)\[(\d*)\]$/.exec(type);
    if (array) {
      if (!Array.isArray(value)) {
        // Not a list where the types say one: what would be signed isn't what's shown.
        rows.push([path, '(not a list)']);
        malformed = true;
        return;
      }
      const items = value;
      if (!items.length) rows.push([path, '(empty list)']);
      for (const [i, item] of items.entries()) {
        walk(array[1] as string, item, `${path}[${i}]`, depth + 1);
      }
      return;
    }
    const fields = Object.hasOwn(types, type) ? types[type] : undefined;
    if (Array.isArray(fields)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rows.push([path, '(missing)']);
        malformed = true;
        return;
      }
      const record = value as Record<string, unknown>;
      for (const f of fields) {
        walk(f.type, record[f.name], path ? `${path}.${f.name}` : f.name, depth + 1);
      }
      return;
    }
    if (value === undefined || value === null) {
      rows.push([path, '(missing)']);
      malformed = true;
      return;
    }
    rows.push([escapeReviewText(path), displayTypedValue(value)]);
  };
  walk(primaryType, message, '', 0);
  return { rows, complete: !truncated && !malformed };
}
