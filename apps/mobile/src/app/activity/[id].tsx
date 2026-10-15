import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { Linking, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { TokenIcon } from '@/components/wallet/parts';
import { SheetScreen, StatRow } from '@/components/wallet/Sheet';
import { ACTIVITY, ACTIVITY_DETAILS, chainSymbol, formatUsd } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const TITLE = { sent: 'Sent', received: 'Received', swapped: 'Swapped', approved: 'Approved' };

/** Transaction details, after Uniswap's activity sheet. */
export default function ActivitySheet() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const c = useTheme();
  const activity = ACTIVITY.find((a) => a.id === id);
  const detail = ACTIVITY_DETAILS[id];
  if (!activity || !detail) return null;

  return (
    <SheetScreen>
      <View style={styles.header}>
        <TokenIcon symbol={activity.symbol} size={40} />
        <View style={styles.flex}>
          <Text style={styles.title}>{TITLE[activity.kind]}</Text>
          <Text style={styles.sub}>{detail.time}</Text>
        </View>
        <ActionMenu
          actions={[
            {
              label: 'View on explorer',
              icon: 'globe',
              onPress: () => Linking.openURL('https://etherscan.io'),
            },
            {
              label: 'Copy transaction ID',
              icon: 'copy',
              onPress: async () => {
                await Clipboard.setStringAsync(detail.hash);
                showToast('Transaction ID copied');
              },
            },
            {
              label: 'Report as spam',
              icon: 'warning',
              onPress: () => showToast('Reported. It will be hidden from Activity.'),
            },
          ]}
        />
      </View>

      <View style={styles.amount}>
        <TextsReveal
          id={id}
          align="center"
          first={<Text style={styles.amountText}>{detail.amount}</Text>}
          second={
            detail.usd ? (
              <View style={styles.usd}>
                <TokenIcon symbol={activity.symbol} size={16} />
                <Text style={styles.sub}>{formatUsd(detail.usd)}</Text>
              </View>
            ) : undefined
          }
        />
      </View>

      <View style={styles.rows}>
        <StatRow label={activity.kind === 'received' ? 'From' : 'To'} value={detail.counterparty} />
        <StatRow
          label="Network"
          value={
            <View style={styles.inline}>
              <TokenIcon symbol={chainSymbol(detail.chain)} size={16} />
              <Text style={styles.value}>{detail.chain}</Text>
            </View>
          }
        />
        <StatRow label="Network cost" value={detail.fee} />
        <StatRow
          label="Transaction"
          value={
            <Pressable
              onPress={() => Linking.openURL('https://etherscan.io')}
              style={styles.inline}
            >
              <Text style={styles.value}>{detail.hash}</Text>
              <Icon name="link" size={13} color={c.textSecondary} />
            </Pressable>
          }
        />
        <StatRow label="Submitted on" value={detail.time} />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderColor: c.divider,
  },
  title: {
    color: c.text,
    fontSize: 18,
    fontWeight: '500',
  },
  sub: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  amount: {
    paddingVertical: 30,
    borderBottomWidth: 1,
    borderColor: c.divider,
  },
  amountText: {
    color: c.text,
    fontSize: 34,
    fontWeight: '500',
    textAlign: 'center',
  },
  usd: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rows: {
    paddingTop: 12,
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
}));
