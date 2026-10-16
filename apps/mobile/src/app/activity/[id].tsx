import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { Copyable, DetailGroup, ExplorerLink, StatusPill } from '@/components/wallet/Details';
import { TokenIcon } from '@/components/wallet/parts';
import { SheetScreen, StatRow } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { ACTIVITY, ACTIVITY_DETAILS, type Chain, chainSymbol, formatUsd } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

const TITLE = { sent: 'Sent', received: 'Received', swapped: 'Swapped', approved: 'Approved' };

/** Where each chain's transactions are looked up. */
const EXPLORER: Record<Chain, { name: string; url: string }> = {
  Ethereum: { name: 'Etherscan', url: 'https://etherscan.io' },
  Base: { name: 'Basescan', url: 'https://basescan.org' },
  Solana: { name: 'Solscan', url: 'https://solscan.io' },
  Bitcoin: { name: 'Mempool', url: 'https://mempool.space' },
  Tron: { name: 'Tronscan', url: 'https://tronscan.org' },
  'XRP Ledger': { name: 'XRPScan', url: 'https://xrpscan.com' },
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
  if (!activity || !detail) return null;
  const explorer = EXPLORER[detail.chain];

  return (
    <SheetScreen title={TITLE[activity.kind]}>
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
            <View style={styles.inline}>
              <Copyable value={detail.hash} toast="Transaction ID copied" short={false} />
              <ExplorerLink name={explorer.name} url={explorer.url} />
            </View>
          }
        />
        <StatRow label="Network cost" value={detail.fee} />
        <StatRow label="Submitted" value={detail.time} />
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

const useStyles = makeStyles((c) => ({
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
