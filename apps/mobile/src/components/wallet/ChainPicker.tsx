import type { ChainFamily } from '@honey-wallet/keyring';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { isWeb } from '@/lib/platform';
import { EVM_LOGOS, type ReceiveAddress } from '@/lib/receive';
import { makeStyles, useTheme } from '@/theme';

/** What each network takes, in a few words. */
const SUBTITLES: Partial<Record<ChainFamily, string>> = {
  solana: 'SOL and Solana tokens',
  bitcoin: 'BTC only',
  tron: 'TRX and USDT on Tron',
};

/**
 * Which network you'll receive on, asked before any address is shown: each chain has
 * its own address, so picking first means the address you copy is the right one.
 */
export function ChainPicker({
  entries,
  onPick,
}: {
  entries: ReceiveAddress[];
  onPick: (family: ChainFamily) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.list}>
      {entries.map((entry) => {
        const evm = entry.family === 'evm';
        return (
          <PressableRow
            key={entry.family}
            accessibilityRole="button"
            accessibilityLabel={evm ? 'EVM networks' : entry.title}
            onPress={() => {
              tap();
              onPick(entry.family);
            }}
            style={[styles.row, isWeb && styles.rowWeb]}
          >
            {evm ? (
              // One address for all of them: a few of their logos, overlapped.
              <View style={styles.stack}>
                {EVM_LOGOS.slice(0, 3).map((symbol, i) => (
                  <View key={symbol} style={[styles.stacked, i > 0 && styles.overlap]}>
                    <TokenIcon symbol={symbol} size={24} />
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.single}>
                <TokenIcon symbol={entry.symbol} size={36} />
              </View>
            )}
            <View style={styles.flex}>
              <Text style={styles.title}>{evm ? 'EVM networks' : entry.title}</Text>
              <Text style={styles.subtitle}>
                {/* review: say how many EVM chains the one address covers. */}
                {/* {evm ? 'Ethereum, Base and more' : SUBTITLES[entry.family]} */}
                {evm ? 'Ethereum, Base and 200+ more' : SUBTITLES[entry.family]}
              </Text>
            </View>
            <Icon name="chevronRight" size={14} color={c.textSecondary} />
          </PressableRow>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  list: {
    paddingVertical: 4,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  // review: shorter rows in the 600px-tall extension popup, so Receive's exchange steps fit.
  rowWeb: {
    paddingVertical: 8,
  },
  flex: {
    flex: 1,
  },
  single: {
    width: 60,
    alignItems: 'center',
  },
  stack: {
    width: 60,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  stacked: {
    borderRadius: 14,
    borderWidth: 2,
    borderColor: c.card,
  },
  overlap: {
    marginLeft: -10,
  },
  title: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  subtitle: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
  },
}));
