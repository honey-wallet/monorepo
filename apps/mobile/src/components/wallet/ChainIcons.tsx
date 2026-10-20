import { Text, View } from 'react-native';
import { NetworkBadge } from '@/components/wallet/MultisigParts';
import { TokenIcon } from '@/components/wallet/parts';
import { shortAddress } from '@/lib/mock-wallet';
import type { Deployment } from '@/lib/multisig';
import { receiveAddresses } from '@/lib/receive';
import type { AddedWallet } from '@/lib/wallets';
import { makeStyles, radius } from '@/theme';

/**
 * A wallet's chains as small overlapped icons. Your own wallet: one per address family
 * (ETH, SOL, BTC, NEAR). A shared wallet: its deployments' networks, then "Base · 0x12…"
 * for one or "N chains" for several. `ring` is the surface behind, so overlaps read.
 */
export function ChainIcons({
  wallet,
  deployments,
  size = 18,
  ring,
  label,
  textStyle,
  compact,
}: {
  wallet?: AddedWallet;
  deployments?: Deployment[];
  size?: number;
  ring: string;
  /** Text before the chain label, e.g. "2 waiting · ". */
  label?: string;
  textStyle?: object;
  /** Narrow rows: one chain shows just its address beside the badge, no network name. */
  compact?: boolean;
}) {
  const styles = useStyles();
  const ringStyle = { ...radius(size / 2 + 2), borderWidth: 2, borderColor: ring };
  const icons = deployments
    ? deployments.map((d) => ({
        key: d.multisig.walletId,
        node: <NetworkBadge network={d.multisig.network} size={size} />,
      }))
    : wallet
      ? receiveAddresses(wallet).map((e) => ({
          key: e.family,
          node: <TokenIcon symbol={e.symbol} size={size} />,
        }))
      : [];
  const text = deployments?.length
    ? deployments.length > 1
      ? `${deployments.length} chains`
      : compact
        ? shortAddress(deployments[0].address, 6, 4)
        : `${deployments[0].multisig.network.name} · ${shortAddress(deployments[0].address)}`
    : null;
  return (
    <View style={styles.row}>
      {label ? (
        <Text style={[styles.text, styles.label, textStyle]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      {icons.map((icon, i) => (
        <View key={icon.key} style={[ringStyle, i > 0 && styles.overlap]}>
          {icon.node}
        </View>
      ))}
      {text ? (
        <Text style={[styles.text, styles.chainText, textStyle]} numberOfLines={1}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  overlap: {
    marginLeft: -6,
  },
  text: {
    color: c.textSecondary,
    fontSize: 13,
  },
  label: {
    marginRight: 4,
  },
  chainText: {
    marginLeft: 6,
    flexShrink: 1,
  },
}));
