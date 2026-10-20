import type { ChainFamily } from '@honey-wallet/keyring';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { TiltCard } from '@/components/motion/TiltCard';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { ChainPicker } from '@/components/wallet/ChainPicker';
import { NetworkBadge, networkLabel } from '@/components/wallet/MultisigParts';
import { TokenIcon } from '@/components/wallet/parts';
import { QRCode } from '@/components/wallet/QRCode';
import { useCopy } from '@/lib/copy';
import { demoLabel } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { useMultisig } from '@/lib/multisig';
import { useProfile } from '@/lib/profile';
import { EVM_LOGOS, receiveAddresses } from '@/lib/receive';
import { isFixtureWallet, isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

const QR_SIZE = 240;

// const EVM_CHAINS = CHAINS.filter((ch) => ch.name === 'Ethereum' || ch.name === 'Base');
/** Every EVM network Honey supports: one address works on all of them. */

/**
 * Your receive QR code, after Uniswap's: name, dotted code, full address. Opened
 * from the scanner it offers "Scan a QR code" to switch back; from Receive it doesn't.
 */
export default function MyQRSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const { from, chain } = useLocalSearchParams<{ from?: string; chain?: ChainFamily }>();
  // The wallet in use; a shared wallet's code says which network it's on.
  const wallet = useActiveWallet();
  const multisig = useMultisig(wallet.id);
  const isMain = isMainWallet(wallet);
  // One chain's address (from Receive's list); otherwise the EVM one.
  const list = receiveAddresses(wallet);
  const entry = list.find((e) => e.family === chain) ?? list[0];
  const address = entry?.address ?? wallet.address;
  const { copied, copy } = useCopy(address);

  if (isFixtureWallet(wallet))
    return (
      <SheetScreen title={demoLabel('Demo wallet', 'My QR')}>
        <Text style={{ color: c.text }}>Create or import a wallet before receiving funds.</Text>
      </SheetScreen>
    );

  // Opened without a network (from Home): ask which one first.
  if (!chain && !multisig && list.length > 1)
    return (
      <SheetScreen title="Which network?">
        <SheetText lead>Each network has its own address.</SheetText>
        <View style={styles.picker}>
          <ChainPicker entries={list} onPick={(family) => router.setParams({ chain: family })} />
        </View>
      </SheetScreen>
    );

  return (
    <SheetScreen
      contentStyle={styles.top}
      footer={
        from === 'scan' && (
          <PressableScale
            onPress={() => {
              tap();
              router.replace('/scan');
            }}
            style={styles.scan}
          >
            <Icon name="scan" size={18} color={c.text} />
            <Text style={styles.scanLabel}>Scan a QR code</Text>
          </PressableScale>
        )
      }
    >
      <TextsReveal
        id="qr"
        align="center"
        first={<Text style={styles.handle}>{isMain ? profile.name : wallet.label}</Text>}
      />
      {/* Press and drag to tilt the code toward your finger; it rests flat to scan. */}
      <TiltCard style={styles.qr}>
        <QRCode
          value={
            multisig?.protocol === 'squads'
              ? `solana:${wallet.address}`
              : (entry?.uri ?? `ethereum:${wallet.address}`)
          }
          size={QR_SIZE}
          color={c.primary}
          center={
            <View style={styles.qrCenter}>
              {multisig ? (
                <NetworkBadge network={multisig.network} size={50} />
              ) : isMain ? (
                <Avatar
                  name={profile.name}
                  size={50}
                  uri={profile.photo}
                  seed={profile.avatarSeed}
                />
              ) : (
                <Avatar name={wallet.label} size={50} seed={wallet.id} />
              )}
            </View>
          }
        />
      </TiltCard>

      <Pressable onPress={copy} style={styles.addressBox}>
        <View style={styles.addressLabelRow}>
          <Text style={styles.addressLabel}>Wallet address</Text>
          <IconSwap name={copied ? 'check' : 'copy'} size={12} color={c.textSecondary} />
        </View>
        {/* Two even lines (as Aave shows it) rather than a full line and a stray tail. */}
        <Text style={styles.address}>
          {`${address.slice(0, Math.ceil(address.length / 2))}\n${address.slice(Math.ceil(address.length / 2))}`}
        </Text>
      </Pressable>

      {multisig ? (
        <View style={styles.networks}>
          <Text style={styles.networksText}>
            Only on {multisig.network.name}. This is a {networkLabel(multisig)} shared wallet.
          </Text>
        </View>
      ) : entry && entry.family !== 'evm' ? (
        <View style={styles.networks}>
          <Text style={styles.networksText}>
            Only send {entry.name} tokens here. Other networks have their own address.
          </Text>
        </View>
      ) : (
        // The EVM address works on every EVM network, but not on Bitcoin, Solana and the rest.
        <View style={styles.networksRow}>
          <Text style={styles.networksText}>Available on</Text>
          <View style={styles.chainStack}>
            {EVM_LOGOS.map((symbol) => (
              <TokenIcon key={symbol} symbol={symbol} size={20} />
            ))}
          </View>
        </View>
      )}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  top: {
    alignItems: 'center',
  },
  // review: extra space above the list; the same gap as Receive's.
  picker: {
    // marginTop: 16,
    marginTop: 8,
  },
  handle: {
    color: c.text,
    fontSize: 20,
    fontWeight: '500',
  },
  qr: {
    marginTop: 24,
  },
  qrCenter: {
    padding: 6,
    ...radius(40),
    backgroundColor: c.sheet,
  },
  addressBox: {
    marginTop: 28,
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 6,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  addressLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addressLabel: {
    color: c.textSecondary,
    fontSize: 13,
  },
  address: {
    color: c.text,
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
  },
  networks: {
    marginTop: 16,
    alignItems: 'center',
    gap: 4,
  },
  networksText: {
    color: c.text,
    fontSize: 15,
    // A two-line warning (Bitcoin, Solana…) stays centred under the code.
    textAlign: 'center',
  },
  networksRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  chainStack: {
    flexDirection: 'row',
    gap: 4,
  },
  chainOverlap: {
    marginLeft: -5,
  },
  networksCount: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  scan: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    paddingHorizontal: 22,
    borderRadius: 26,
    backgroundColor: c.raised,
  },
  scanLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
}));
