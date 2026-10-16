import type { IconName } from '@/components/Icon';
import { type Chain, formatUsd } from '@/lib/mock-wallet';
import { notify } from '@/lib/push';
import { createStore } from '@/lib/store';
import { showToast } from '@/lib/toast';
import { addWallet, demoAddress, useActiveWallet, wallets } from '@/lib/wallets';

/**
 * Shared wallets (multisigs). Every outgoing action from one is a proposal that
 * members approve; once enough have, Honey's relayer submits it. Built on Safe
 * (EVM networks) and Squads (Solana). In memory for now, like the rest of the demo.
 */

/** Why the wallet exists; sets the wording, suggested members and default rule. */
export type MultisigPurpose = 'vault' | 'family' | 'team';
export type MultisigProtocol = 'safe' | 'squads';

/**
 * Who (or what) holds one of the keys. In a vault every member is you: this phone,
 * another device, a hardware wallet or a recovery key. Elsewhere they're people.
 */
export type MemberKind = 'you' | 'device' | 'hardware' | 'recovery' | 'person';

export type Member = {
  id: string;
  name: string;
  kind: MemberKind;
  /** A Honey handle, e.g. "maya.honey". */
  handle?: string;
  address: string;
};

export type MultisigHolding = { symbol: string; chain: Chain; amount: number; usd: number };

/**
 * Where a shared wallet lives: an EVM network (any of them; Safe deploys anywhere),
 * by chain id, or Solana (Squads), whose chain id is null.
 */
export type MultisigNetwork = { name: string; chainId: number | null; native: string };

export const SOLANA_NETWORK: MultisigNetwork = { name: 'Solana', chainId: null, native: 'SOL' };

export type Multisig = {
  walletId: string;
  purpose: MultisigPurpose;
  protocol: MultisigProtocol;
  network: MultisigNetwork;
  members: Member[];
  /** Approvals needed to act. */
  threshold: number;
  /** Any one member can spend up to this many dollars a day without approvals. */
  dailyLimit: number | null;
  spentToday: number;
  holdings: MultisigHolding[];
};

type Amount = { symbol: string; amount: number };

/** Everything a shared wallet can do; each one goes through approvals. */
export type ProposalAction =
  | { type: 'send'; symbol: string; chain: Chain; amount: number; usd: number; to: string }
  | { type: 'swap'; from: Amount; to: Amount; usd: number; withApproval: boolean }
  | { type: 'earnDeposit' | 'earnWithdraw'; symbol: string; amount: number; usd: number }
  | { type: 'jarAdd' | 'jarWithdraw'; jar: string; symbol: string; amount: number; usd: number }
  | { type: 'sell'; symbol: string; amount: number; usd: number }
  | { type: 'addMember'; member: Member }
  | { type: 'removeMember'; memberId: string; name: string }
  | { type: 'changeThreshold'; threshold: number }
  | { type: 'setDailyLimit'; usd: number | null };

export type Vote = { memberId: string; at: number };

export type Proposal = {
  id: string;
  walletId: string;
  /** Safe and Squads run proposals in order; this is its place in the queue. */
  nonce: number;
  action: ProposalAction;
  createdBy: string;
  createdAt: number;
  approvals: Vote[];
  rejections: Vote[];
  status: 'pending' | 'executed' | 'rejected' | 'cancelled';
  doneAt?: number;
};

/** Something that happened on a shared wallet, for Notifications. */
export type MultisigEvent = {
  id: string;
  proposalId: string;
  kind: 'approved' | 'rejected' | 'executed';
  memberName: string;
  at: number;
};

export const YOU = 'you';

export const PURPOSES: Record<
  MultisigPurpose,
  { title: string; why: string; icon: IconName; members: string }
> = {
  vault: {
    title: 'Vault for me',
    why: 'Your savings on more than one key. Lose your phone and nothing is lost.',
    icon: 'shield',
    members: 'Keys',
  },
  family: {
    title: 'Shared with family',
    why: 'Money you share. Big spends need a second yes.',
    icon: 'multisig',
    members: 'Members',
  },
  team: {
    title: 'Team treasury',
    why: 'A team or club. Every payment is approved and on record.',
    icon: 'layers',
    members: 'Members',
  },
};

/** A network's protocol: Squads on Solana, Safe everywhere else. */
export const protocolFor = (n: MultisigNetwork): MultisigProtocol =>
  n.chainId === null ? 'squads' : 'safe';

/** Rough one-time setup cost, where known; elsewhere just the network fee. */
export function setupCost(n: MultisigNetwork) {
  if (n.chainId === null) return '0.003 SOL';
  if (n.chainId === 1) return '≈ $4.80';
  if (n.chainId === 8453 || n.chainId === 10 || n.chainId === 42161) return '≈ $0.05';
  return `A small ${n.native} network fee`;
}

export const protocolName = (p: MultisigProtocol) => (p === 'safe' ? 'Safe' : 'Squads');

/** The default rule for a group: a majority, so one lost key never locks anyone out. */
export const recommendedThreshold = (members: number) =>
  members <= 1 ? 1 : members === 2 ? 2 : Math.floor(members / 2) + 1;

const now = Date.now();
const minutesAgo = (m: number) => now - m * 60_000;

const you = (name = 'This iPhone'): Member => ({
  id: YOU,
  name,
  kind: 'you',
  address: '0x7a3F9c21b4E8d0a5C6f1E2B39d4a8C7e5F01aB3c',
});
const person = (id: string, name: string, address: string): Member => ({
  id,
  name,
  kind: 'person',
  handle: `${name.toLowerCase()}.honey`,
  address,
});

type State = {
  multisigs: Record<string, Multisig>;
  proposals: Proposal[];
  events: MultisigEvent[];
};

const store = createStore<State>({
  multisigs: {
    family: {
      walletId: 'family',
      purpose: 'family',
      protocol: 'safe',
      network: { name: 'Base', chainId: 8453, native: 'ETH' },
      members: [
        you('You'),
        person('maya', 'Maya', '0x41CDe2b7A9f03c5D8e1B6a4F2c9d7E0b3a5Cee3'),
        person('dad', 'Dad', '0xBf32a8C1e5D9f0b7A62d4E3c8b1f0a9e92a4312'),
      ],
      threshold: 2,
      dailyLimit: null,
      spentToday: 0,
      holdings: [
        { symbol: 'USDC', chain: 'Base', amount: 80.2, usd: 80.2 },
        { symbol: 'ETH', chain: 'Base', amount: 0.016, usd: 40.2 },
      ],
    },
    team: {
      walletId: 'team',
      purpose: 'team',
      protocol: 'safe',
      network: { name: 'Ethereum', chainId: 1, native: 'ETH' },
      members: [
        you('You'),
        person('arjun', 'Arjun', '0x8a91F0c3B7a2D8e4f6A1b5C9d3E7f2a8B6c4100'),
        person('lena', 'Lena', '0x3c7e91F0c3B7a2D8e4f6A1b5C9d3E7f2a8B6c42'),
        person('kai', 'Kai', '0x5d2e91F0c3B7a2D8e4f6A1b5C9d3E7f2a8B6c43'),
        person('sam', 'Sam', '0x9f1e91F0c3B7a2D8e4f6A1b5C9d3E7f2a8B6c44'),
      ],
      threshold: 3,
      dailyLimit: 250,
      spentToday: 40,
      holdings: [
        { symbol: 'USDC', chain: 'Ethereum', amount: 1200, usd: 1200 },
        { symbol: 'ETH', chain: 'Ethereum', amount: 0.0876, usd: 220.06 },
      ],
    },
  },
  proposals: [
    {
      id: 'p-rent',
      walletId: 'family',
      nonce: 7,
      action: {
        type: 'send',
        symbol: 'USDC',
        chain: 'Base',
        amount: 50,
        usd: 50,
        to: '0x2E8f1a7B3c9D0e5F6a2b8C4d1E7f3A9b05e41Cd',
      },
      createdBy: 'maya',
      createdAt: minutesAgo(25),
      approvals: [{ memberId: 'maya', at: minutesAgo(25) }],
      rejections: [],
      status: 'pending',
    },
    {
      id: 'p-swap',
      walletId: 'team',
      nonce: 41,
      action: {
        type: 'swap',
        from: { symbol: 'USDC', amount: 500 },
        to: { symbol: 'ETH', amount: 0.1992 },
        usd: 500,
        withApproval: true,
      },
      createdBy: 'arjun',
      createdAt: minutesAgo(90),
      approvals: [
        { memberId: 'arjun', at: minutesAgo(90) },
        { memberId: 'lena', at: minutesAgo(40) },
      ],
      rejections: [],
      status: 'pending',
    },
    {
      id: 'p-member',
      walletId: 'team',
      nonce: 42,
      action: {
        type: 'addMember',
        member: person('priya', 'Priya', '0x7b4e91F0c3B7a2D8e4f6A1b5C9d3E7f2a8B6c45'),
      },
      createdBy: 'lena',
      createdAt: minutesAgo(30),
      approvals: [{ memberId: 'lena', at: minutesAgo(30) }],
      rejections: [],
      status: 'pending',
    },
    {
      id: 'p-design',
      walletId: 'team',
      nonce: 40,
      action: {
        type: 'send',
        symbol: 'USDC',
        chain: 'Ethereum',
        amount: 300,
        usd: 300,
        to: '0x6aB3c7a3F9c21b4E8d0a5C6f1E2B39d4a8C7e5F0',
      },
      createdBy: 'kai',
      createdAt: minutesAgo(60 * 26),
      approvals: [
        { memberId: 'kai', at: minutesAgo(60 * 26) },
        { memberId: YOU, at: minutesAgo(60 * 25) },
        { memberId: 'sam', at: minutesAgo(60 * 24) },
      ],
      rejections: [],
      status: 'executed',
      doneAt: minutesAgo(60 * 24),
    },
  ],
  events: [],
});

export const useMultisigState = store.use;

// ---------------------------------------------------------------------------
// Reading

export function multisigOf(state: State, walletId: string): Multisig | undefined {
  return state.multisigs[walletId];
}

export function useMultisig(walletId: string | undefined) {
  const state = store.use();
  return walletId ? state.multisigs[walletId] : undefined;
}

/** The shared wallet you're using, if the active wallet is one. */
export function useActiveMultisig() {
  const wallet = useActiveWallet();
  return useMultisig(wallet.id);
}

export function useProposal(id: string) {
  return store.use().proposals.find((p) => p.id === id);
}

/** A wallet's proposals: pending ones first (in queue order), then history, newest first. */
export function useProposals(walletId: string) {
  const { proposals } = store.use();
  const mine = proposals.filter((p) => p.walletId === walletId);
  return {
    pending: mine.filter((p) => p.status === 'pending').sort((a, b) => a.nonce - b.nonce),
    history: mine
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt)),
  };
}

export const hasVoted = (p: Proposal, memberId: string) =>
  p.approvals.some((v) => v.memberId === memberId) ||
  p.rejections.some((v) => v.memberId === memberId);

/** Pending proposals, on any of your shared wallets, still waiting for your answer. */
export function useNeedsMyApproval() {
  const { proposals } = store.use();
  return proposals.filter((p) => p.status === 'pending' && !hasVoted(p, YOU));
}

export const useMultisigEvents = () => store.use().events;

export const memberOf = (m: Multisig, id: string) => m.members.find((x) => x.id === id);

/**
 * Who did something, in a sentence: "You", a person's name, or "Your hardware
 * wallet" for one of your own keys (a vault's members are all you).
 */
export function actorName(m: Multisig | undefined, id: string) {
  if (id === YOU) return 'You';
  const member = m && memberOf(m, id);
  if (!member) return 'Someone';
  return member.kind === 'person' ? member.name : `Your ${member.name.toLowerCase()}`;
}

/** How a member is named in the app: "You" for you, else their name. */
export const memberName = (m: Multisig | undefined, id: string) =>
  id === YOU ? 'You' : ((m && memberOf(m, id)?.name) ?? 'Someone');

// ---------------------------------------------------------------------------
// Describing actions

/** A one-line summary of an action, for lists, notifications and the proposal page. */
export function describe(action: ProposalAction): {
  title: string;
  done: string;
  icon: IconName;
  symbol?: string;
} {
  const amt = (a: number, s: string) => `${trim(a)} ${s}`;
  switch (action.type) {
    case 'send':
      return {
        title: `Send ${amt(action.amount, action.symbol)}`,
        done: 'Sent',
        icon: 'send',
        symbol: action.symbol,
      };
    case 'swap':
      return {
        title: `Swap ${amt(action.from.amount, action.from.symbol)} to ${action.to.symbol}`,
        done: 'Swapped',
        icon: 'trade',
        symbol: action.from.symbol,
      };
    case 'earnDeposit':
      return {
        title: `Deposit ${amt(action.amount, action.symbol)} to earn`,
        done: 'Deposited',
        icon: 'piggyBank',
        symbol: action.symbol,
      };
    case 'earnWithdraw':
      return {
        title: `Withdraw ${amt(action.amount, action.symbol)} from earn`,
        done: 'Withdrawn',
        icon: 'piggyBank',
        symbol: action.symbol,
      };
    case 'jarAdd':
      return {
        title: `Add ${amt(action.amount, action.symbol)} to ${action.jar}`,
        done: 'Added',
        icon: 'piggyBank',
        symbol: action.symbol,
      };
    case 'jarWithdraw':
      return {
        title: `Withdraw ${amt(action.amount, action.symbol)} from ${action.jar}`,
        done: 'Withdrawn',
        icon: 'piggyBank',
        symbol: action.symbol,
      };
    case 'sell':
      return {
        title: `Sell ${amt(action.amount, action.symbol)}`,
        done: 'Sold',
        icon: 'sell',
        symbol: action.symbol,
      };
    case 'addMember':
      return { title: `Add ${action.member.name}`, done: 'Member added', icon: 'multisig' };
    case 'removeMember':
      return { title: `Remove ${action.name}`, done: 'Member removed', icon: 'multisig' };
    case 'changeThreshold':
      return {
        title: `Require ${action.threshold} approvals`,
        done: 'Rule changed',
        icon: 'checkCircle',
      };
    case 'setDailyLimit':
      return {
        title: action.usd ? `Daily limit ${formatUsd(action.usd)}` : 'Remove daily limit',
        done: 'Limit changed',
        icon: 'clock',
      };
  }
}

/** Dollar value moved by an action (config changes move nothing). */
export function usdOf(action: ProposalAction) {
  return 'usd' in action && typeof action.usd === 'number' ? action.usd : 0;
}

const trim = (n: number) => (n >= 1 ? Number(n.toFixed(4)) : Number(n.toPrecision(3))).toString();

// ---------------------------------------------------------------------------
// Acting

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;

/** True when an action can skip approvals because it fits in today's limit. */
export function withinDailyLimit(m: Multisig, action: ProposalAction) {
  const usd = usdOf(action);
  return (
    m.dailyLimit !== null && usd > 0 && !isConfig(action) && m.spentToday + usd <= m.dailyLimit
  );
}

const isConfig = (a: ProposalAction) =>
  a.type === 'addMember' ||
  a.type === 'removeMember' ||
  a.type === 'changeThreshold' ||
  a.type === 'setDailyLimit';

/** Applies an executed proposal's effect on the wallet (members, rules, spending). */
function applyEffect(m: Multisig, action: ProposalAction): Multisig {
  switch (action.type) {
    case 'addMember':
      return { ...m, members: [...m.members, action.member] };
    case 'removeMember': {
      const members = m.members.filter((x) => x.id !== action.memberId);
      return { ...m, members, threshold: Math.min(m.threshold, members.length) };
    }
    case 'changeThreshold':
      return { ...m, threshold: action.threshold };
    case 'setDailyLimit':
      return { ...m, dailyLimit: action.usd };
    default:
      return m;
  }
}

/** Records a vote, and executes or rejects the proposal once the outcome is certain. */
function vote(proposalId: string, memberId: string, kind: 'approve' | 'reject') {
  let outcome = 'pending' as Proposal['status'];
  store.set((s) => {
    const p = s.proposals.find((x) => x.id === proposalId);
    const m = p && s.multisigs[p.walletId];
    if (!p || !m || p.status !== 'pending' || hasVoted(p, memberId)) return s;
    const at = Date.now();
    const next: Proposal =
      kind === 'approve'
        ? { ...p, approvals: [...p.approvals, { memberId, at }] }
        : { ...p, rejections: [...p.rejections, { memberId, at }] };
    // Executes once enough approve; rejected once enough refuse that it never could.
    if (next.approvals.length >= m.threshold) outcome = 'executed';
    else if (next.rejections.length > m.members.length - m.threshold) outcome = 'rejected';
    const done = outcome === 'pending' ? next : { ...next, status: outcome, doneAt: at };
    const multisig =
      outcome === 'executed'
        ? {
            ...applyEffect(m, p.action),
            spentToday: m.spentToday + usdOf(p.action),
          }
        : m;
    const events: MultisigEvent[] = [
      {
        id: nextId('e'),
        proposalId,
        kind: kind === 'approve' ? 'approved' : 'rejected',
        memberName: actorName(m, memberId),
        at,
      },
      ...(outcome === 'executed'
        ? [{ id: nextId('e'), proposalId, kind: 'executed' as const, memberName: '', at }]
        : []),
      ...s.events,
    ];
    return {
      multisigs: { ...s.multisigs, [m.walletId]: multisig },
      proposals: s.proposals.map((x) => (x.id === proposalId ? done : x)),
      events,
    };
  });
  return outcome as Proposal['status'];
}

export const approve = (proposalId: string) => vote(proposalId, YOU, 'approve');
export const reject = (proposalId: string) => vote(proposalId, YOU, 'reject');

export function cancel(proposalId: string) {
  store.set((s) => ({
    ...s,
    proposals: s.proposals.map((p) =>
      p.id === proposalId && p.status === 'pending'
        ? { ...p, status: 'cancelled' as const, doneAt: Date.now() }
        : p,
    ),
  }));
}

/** How long until another member "approves" a proposal you made, in the demo. */
const DEMO_APPROVAL_MS = 4000;

/**
 * Proposes an action from a shared wallet, with your approval on it. Under the daily
 * limit, or when you alone are enough, it goes straight through. Returns the
 * proposal and whether it already executed.
 */
export function propose(walletId: string, action: ProposalAction) {
  const s = store.get();
  const m = s.multisigs[walletId];
  if (!m) throw new Error(`No shared wallet ${walletId}`);
  const at = Date.now();
  const nonce =
    Math.max(0, ...s.proposals.filter((p) => p.walletId === walletId).map((p) => p.nonce)) + 1;
  const instant = withinDailyLimit(m, action) || m.threshold <= 1;
  const proposal: Proposal = {
    id: nextId('p'),
    walletId,
    nonce,
    action,
    createdBy: YOU,
    createdAt: at,
    approvals: [{ memberId: YOU, at }],
    rejections: [],
    status: instant ? 'executed' : 'pending',
    doneAt: instant ? at : undefined,
  };
  store.set((prev) => ({
    ...prev,
    multisigs: instant
      ? {
          ...prev.multisigs,
          [walletId]: {
            ...applyEffect(m, action),
            spentToday: m.spentToday + usdOf(action),
          },
        }
      : prev.multisigs,
    proposals: [...prev.proposals, proposal],
  }));
  if (!instant) demoApproval(proposal.id, m);
  return { proposal, executed: instant };
}

/**
 * In the demo, the next member approves a few seconds after you propose, so the
 * whole flow can be seen without a second phone.
 */
function demoApproval(proposalId: string, m: Multisig) {
  const other = m.members.find((x) => x.id !== YOU);
  if (!other) return;
  setTimeout(() => {
    const outcome = vote(proposalId, other.id, 'approve');
    const p = store.get().proposals.find((x) => x.id === proposalId);
    if (!p || p.approvals.every((v) => v.memberId !== other.id)) return;
    const what = describe(p.action).title;
    const who = actorName(m, other.id);
    const wallet = walletName(m.walletId);
    const title =
      outcome === 'executed' ? `${describe(p.action).done}: ${what}` : `${who} approved`;
    const body =
      outcome === 'executed'
        ? `${who} approved, so it went through · ${wallet}`
        : `“${what}” · ${approvalsLeft(store.get().multisigs[p.walletId] ?? m, p)} more to go · ${wallet}`;
    // A system notification when allowed, else an in-app toast.
    notify({ title, body, proposalId }).then((shown) => {
      if (!shown) showToast(`${title}. ${body}`);
    });
  }, DEMO_APPROVAL_MS);
}

/** A wallet's name, for notifications. */
function walletName(walletId: string) {
  const known: Record<string, string> = { family: 'Family', team: 'Team Treasury' };
  return (
    known[walletId] ?? wallets.get().added.find((w) => w.id === walletId)?.label ?? 'Shared wallet'
  );
}

/** How long after launch the demo's incoming request arrives. */
const DEMO_REQUEST_MS = 15_000;
let demoRequested = false;

/**
 * In the demo, a member of the Family wallet asks for your approval a little after
 * launch, so the request notification (with Review and Reject) can be seen.
 */
export function startDemoRequests() {
  if (demoRequested) return;
  demoRequested = true;
  setTimeout(() => {
    const s = store.get();
    const m = s.multisigs.family;
    if (!m) return;
    const nonce =
      Math.max(0, ...s.proposals.filter((p) => p.walletId === 'family').map((p) => p.nonce)) + 1;
    const at = Date.now();
    const proposal: Proposal = {
      id: nextId('p'),
      walletId: 'family',
      nonce,
      action: {
        type: 'send',
        symbol: 'USDC',
        chain: 'Base',
        amount: 25,
        usd: 25,
        to: '0x9C3d7a3F9c21b4E8d0a5C6f1E2B39d4a8C7e5F01',
      },
      createdBy: 'maya',
      createdAt: at,
      approvals: [{ memberId: 'maya', at }],
      rejections: [],
      status: 'pending',
    };
    store.set((prev) => ({ ...prev, proposals: [...prev.proposals, proposal] }));
    notify({
      title: 'Maya wants to send 25 USDC',
      body: 'Family · needs your approval',
      proposalId: proposal.id,
      approval: true,
    }).then((shown) => {
      if (!shown) showToast('Maya wants to send 25 USDC from Family');
    });
  }, DEMO_REQUEST_MS);
}

/** A Solana-looking address, for Squads wallets made in the demo. */
function demoSolanaAddress() {
  const abc = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 44; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

/** Creates a shared wallet, switches to it, and returns its id. */
export function createMultisig(input: {
  name: string;
  purpose: MultisigPurpose;
  network: MultisigNetwork;
  members: Member[];
  threshold: number;
}) {
  const protocol = protocolFor(input.network);
  const address = protocol === 'squads' ? demoSolanaAddress() : demoAddress();
  const walletId = addWallet({
    kind: 'multisig',
    label: input.name,
    address,
    usd: 0,
    threshold: [input.threshold, input.members.length],
  });
  store.set((s) => ({
    ...s,
    multisigs: {
      ...s.multisigs,
      [walletId]: {
        walletId,
        purpose: input.purpose,
        protocol,
        network: input.network,
        members: input.members,
        threshold: input.threshold,
        dailyLimit: null,
        spentToday: 0,
        holdings: [],
      },
    },
  }));
  return walletId;
}

/** "just now", "25 min ago", "3 h ago", "2 d ago". */
export function timeAgo(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Approvals still missing before a proposal goes through. */
export const approvalsLeft = (m: Multisig, p: Proposal) =>
  Math.max(0, m.threshold - p.approvals.length);

/**
 * How the active wallet acts. A normal wallet acts directly; a shared one proposes,
 * unless the amount fits in its daily limit (or one approval is enough).
 */
export function useSigner() {
  const wallet = useActiveWallet();
  const multisig = useMultisig(wallet.id);
  const proposes = (action: ProposalAction) =>
    !!multisig && multisig.threshold > 1 && !withinDailyLimit(multisig, action);
  return {
    walletId: wallet.id,
    multisig,
    proposes,
    /** The main button's label: the action's own verb, or "Propose". */
    cta: (verb: string, action: ProposalAction) => (proposes(action) ? 'Propose' : verb),
    /** For the review page: the rule this action goes through, or null for a normal wallet. */
    rule: (action: ProposalAction) =>
      !multisig
        ? null
        : proposes(action)
          ? `${multisig.threshold} of ${multisig.members.length} must approve`
          : multisig.threshold > 1
            ? "Within today's limit · no approvals"
            : 'Goes through right away',
  };
}

/** A new member's id. */
export const newMemberId = () => nextId('m');

export { you as yourKey };
