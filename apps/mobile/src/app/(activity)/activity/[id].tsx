import { router, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { Share, Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable, DetailGroup, ExplorerLink, StatusPill } from '@/components/sheets/Details';
import { closeSheet, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { ACTIVITY, ACTIVITY_DETAILS, type Chain, chainSymbol, formatUsd } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

const TITLE = { sent: 'Sent', received: 'Received', swapped: 'Swapped', approved: 'Approved' };

/** Where each chain's transactions are looked up. */
const EXPLORER: Record<Chain, { name: string; tx: (hash: string) => string }> = {
  Ethereum: { name: 'Etherscan', tx: (h) => `https://etherscan.io/tx/${h}` },
  Base: { name: 'Basescan', tx: (h) => `https://basescan.org/tx/${h}` },
  Solana: { name: 'Solscan', tx: (h) => `https://solscan.io/tx/${h}` },
  Bitcoin: { name: 'Mempool', tx: (h) => `https://mempool.space/tx/${h}` },
  Tron: { name: 'Tronscan', tx: (h) => `https://tronscan.org/#/transaction/${h}` },
  'XRP Ledger': { name: 'XRPScan', tx: (h) => `https://xrpscan.com/tx/${h}` },
};

/**
 * A transaction, laid out like a proposal: what happened and its status up top, who and
 * where in one block, then the transaction itself (hash, cost, time) in another.
 */
export default function ActivitySheet() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const activity = ACTIVITY.find((a) => a.id === id);
  const detail = ACTIVITY_DETAILS[id];
  // The list has what happened; the receipt (hash, cost, time) is looked up on the chain.
  const loading = useFirstLoad(LOADS.tx(id));
  if (!activity || !detail) {
    return (
      <SheetScreen title="Transaction">
        <EmptyState
          icon="history"
          title="Transaction not found"
          hint="It may still be confirming, or it was hidden as spam."
          action={{ label: 'Back to Activity', onPress: () => router.back() }}
        />
      </SheetScreen>
    );
  }
  const explorer = EXPLORER[detail.chain];
  const link = explorer.tx(detail.hash);
  const share = () => {
    Share.share({
      message: `${TITLE[activity.kind]} ${detail.amount} on ${detail.chain}\n${link}`,
    }).catch(() => {});
  };

  return (
    <SheetScreen
      title={TITLE[activity.kind]}
      right={<HeaderShortcut icon="share" label="Share transaction" onPress={share} />}
      footer={
        <View style={styles.actions}>
          <PillButton
            label="Share"
            variant="secondary"
            onPress={() => {
              tap();
              share();
            }}
            style={styles.flex}
          />
          <PillButton label="Done" onPress={() => closeSheet()} style={styles.flex} />
        </View>
      }
    >
      <View style={styles.summary}>
        <TokenIcon symbol={activity.symbol} size={40} />
        <TextsReveal
          id={id}
          align="center"
          first={<Text style={styles.amount}>{detail.amount}</Text>}
          second={detail.usd ? <Text style={styles.usd}>{formatUsd(detail.usd)}</Text> : undefined}
        />
        <StatusPill tone="done" icon="checkCircle" text="Confirmed" />
      </View>

      <DetailGroup>
        <StatRow label={activity.kind === 'received' ? 'From' : 'To'} value={detail.counterparty} />
        <StatRow
          label="Chain"
          value={
            <View style={styles.inline}>
              <TokenIcon symbol={chainSymbol(detail.chain)} size={18} />
              <Text style={styles.value}>{detail.chain}</Text>
            </View>
          }
        />
      </DetailGroup>

      <DetailGroup title="Transaction">
        <StatRow
          label="Transaction hash"
          value={
            <Receipt loading={loading} width={150}>
              <View style={styles.inline}>
                <Copyable value={detail.hash} toast="Transaction ID copied" short={false} />
                <ExplorerLink name={explorer.name} url={link} />
              </View>
            </Receipt>
          }
        />
        <StatRow
          label="Network cost"
          value={
            <Receipt loading={loading} width={64}>
              <Text style={styles.value}>{detail.fee}</Text>
            </Receipt>
          }
        />
        <StatRow
          label="Submitted"
          value={
            <Receipt loading={loading} width={110}>
              <Text style={styles.value}>{detail.time}</Text>
            </Receipt>
          }
        />
      </DetailGroup>

      {activity.kind === 'received' ? (
        <PressableScale
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            tap();
            showToast('Reported. It will be hidden from Activity.');
          }}
          style={styles.report}
        >
          <Text style={styles.reportText}>Report as spam</Text>
        </PressableScale>
      ) : null}
    </SheetScreen>
  );
}

/** A receipt value, or a bar its width until the chain lookup comes back. */
function Receipt({
  loading,
  width,
  children,
}: {
  loading: boolean;
  width: number;
  children: ReactNode;
}) {
  return (
    <SkeletonReveal loading={loading} skeleton={<SkeletonBar width={width} height={14} />}>
      {children}
    </SkeletonReveal>
  );
}

const useStyles = makeStyles((c) => ({
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  summary: {
    alignItems: 'center',
    gap: 6,
    paddingBottom: 16,
  },
  amount: {
    marginTop: 4,
    color: c.text,
    fontSize: 28,
    fontWeight: '600',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  usd: {
    color: c.textSecondary,
    fontSize: 15,
    textAlign: 'center',
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  value: {
    color: c.text,
    fontSize: 16,
  },
  report: {
    alignSelf: 'center',
    marginTop: 16,
    paddingVertical: 4,
  },
  reportText: {
    color: c.textSecondary,
    fontSize: 14,
  },
}));
