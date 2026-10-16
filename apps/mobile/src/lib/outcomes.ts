import { type Href, router } from 'expo-router';
import { useState } from 'react';
import { settings, useSettings } from '@/lib/settings';

/**
 * What can go wrong at the end of a money flow, said the way a person would want to
 * hear it: what happened, whether their money moved (it almost never did), and the one
 * thing to do next. Every failure page leads with the reassurance, because "did I just
 * lose money?" is the first thing anyone thinks.
 */
export type FailureKind =
  | 'network'
  | 'gas'
  | 'priceMoved'
  | 'reverted'
  | 'declined'
  | 'limit'
  | 'marketClosed'
  | 'margin'
  | 'signature';

export type Flow =
  | 'send'
  | 'swap'
  | 'buy'
  | 'sell'
  | 'perp'
  | 'predict'
  | 'savings'
  | 'jar'
  | 'earn'
  | 'proposal'
  | 'multisig';

/** What didn't happen, per flow ("Nothing was sent"). */
const UNDONE: Record<Flow, string> = {
  send: 'Nothing was sent',
  swap: 'Nothing was swapped',
  buy: 'You weren’t charged',
  sell: 'Nothing was sold',
  perp: 'No position was opened',
  predict: 'Nothing was bought',
  savings: 'Nothing was added',
  jar: 'Nothing was moved',
  earn: 'Nothing was deposited',
  proposal: 'Nothing was signed',
  multisig: 'No wallet was created',
};

/** The ways each flow can fail, most likely first. */
export const FLOW_FAILURES: Record<Flow, FailureKind[]> = {
  send: ['network', 'gas', 'reverted'],
  swap: ['priceMoved', 'network', 'gas', 'reverted'],
  buy: ['declined', 'limit', 'network'],
  sell: ['network', 'limit'],
  perp: ['margin', 'priceMoved', 'network'],
  predict: ['priceMoved', 'marketClosed', 'network'],
  savings: ['declined', 'network', 'reverted'],
  jar: ['network', 'reverted'],
  earn: ['network', 'gas', 'reverted'],
  proposal: ['signature', 'network'],
  multisig: ['network', 'gas'],
};

export type Failure = {
  kind: FailureKind;
  title: string;
  reason: string;
  /** Whether money moved: almost always "nothing", said first and plainly. */
  safe: string;
  /** The main way forward: try again, or fix the cause first. */
  action: { label: string; href?: Href };
};

/** The words for one failure in one flow. */
export function describeFailure(kind: FailureKind, flow: Flow): Failure {
  const undone = `${UNDONE[flow]}.`;
  switch (kind) {
    case 'network':
      return {
        kind,
        title: 'Couldn’t connect',
        reason: 'Honey couldn’t reach the network. Check your connection and try again.',
        safe: undone,
        action: { label: 'Try again' },
      };
    case 'gas':
      return {
        kind,
        title: 'Not enough for the network fee',
        reason: 'This needs about $0.40 of ETH to pay the network, and the wallet has less.',
        safe: undone,
        action: { label: 'Add ETH', href: { pathname: '/buy-cash', params: { symbol: 'ETH' } } },
      };
    case 'priceMoved':
      return {
        kind,
        title: 'The price moved',
        reason: 'It changed by more than your 0.5% limit before the order went through.',
        safe: undone,
        action: { label: 'See new price' },
      };
    case 'reverted':
      return {
        kind,
        title: 'The network turned it down',
        reason: 'Something changed on the network mid-way, so the transaction was cancelled.',
        safe: `${undone} Only the $0.03 network fee was used.`,
        action: { label: 'Try again' },
      };
    case 'declined':
      return {
        kind,
        title: 'Card declined',
        reason: 'Your bank declined the payment. Try another card, or pay by bank transfer.',
        safe: 'You weren’t charged.',
        action: { label: 'Pay another way' },
      };
    case 'limit':
      return {
        kind,
        title: 'Over today’s limit',
        reason: 'Card purchases are limited to $500 a day until you verify your identity.',
        safe: flow === 'sell' ? undone : 'You weren’t charged.',
        action: { label: 'Change amount' },
      };
    case 'marketClosed':
      return {
        kind,
        title: 'This market has closed',
        reason: 'Trading stopped before your order went through, so it couldn’t be filled.',
        safe: undone,
        action: {
          label: 'See other markets',
          href: { pathname: '/trade', params: { mode: 'Predict' } },
        },
      };
    case 'margin':
      return {
        kind,
        title: 'Not enough margin',
        reason:
          'At the current price this position needs more margin. Lower the size or the leverage.',
        safe: undone,
        action: { label: 'Change order' },
      };
    case 'signature':
      return {
        kind,
        title: 'Couldn’t sign',
        reason: 'Your signature didn’t reach the other owners. Nothing changes until it does.',
        safe: undone,
        action: { label: 'Try again' },
      };
  }
}

/**
 * DEMO: whether the next confirm in `flow` fails, and how. Off unless "Simulate
 * failures" is on (Settings → Advanced); then each confirm fails, cycling through the
 * flow's failures so every one can be seen. Real failures will come from the API.
 */
const tries: Partial<Record<Flow, number>> = {};
export function demoOutcome(flow: Flow): Failure | null {
  if (!settings.get().simulateFailures) return null;
  const list = FLOW_FAILURES[flow];
  const n = tries[flow] ?? 0;
  tries[flow] = n + 1;
  return describeFailure(list[n % list.length], flow);
}

export const useSimulateFailures = () => useSettings().simulateFailures;

/**
 * Follows a failure's fix, if it has one: closes the current surface (by default the
 * sheet it's in), then opens the fix. Returns false when the action is just a retry.
 */
export function followFix(failure: Failure, close: () => void = () => router.back()) {
  if (!failure.action.href) return false;
  close();
  router.push(failure.action.href);
  return true;
}

/**
 * A flow's failure state: `attempt()` returns the failure for this confirm (or null
 * to carry on to success) and keeps it for the failure page; `clear()` forgets it.
 */
export function useFailure(flow: Flow) {
  const [failure, setFailure] = useState<Failure | null>(null);
  return {
    failure,
    attempt: () => {
      const next = demoOutcome(flow);
      setFailure(next);
      return next;
    },
    clear: () => setFailure(null),
  };
}
