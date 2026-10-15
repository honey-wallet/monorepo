import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { TiltCard } from '@/components/motion/TiltCard';
import { TokenIcon } from '@/components/wallet/parts';
import { QRCode } from '@/components/wallet/QRCode';
import { SheetScreen } from '@/components/wallet/Sheet';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { ADDRESS, CHAINS, handleFor } from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { makeStyles, useTheme } from '@/theme';

const QR_SIZE = 240;

/**
 * Your receive QR code, after Uniswap's: handle, dotted code, full address. Opened
 * from the scanner it offers "Scan a QR code" to switch back; from Receive it doesn't.
 */
export default function MyQRSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { copied, copy } = useCopy(ADDRESS);

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
        first={
          <Text style={styles.handle}>
            {profile.name}
            <Text style={styles.suffix}>
              {handleFor(profile.name).slice(profile.name.trim().length)}
            </Text>
          </Text>
        }
      />
      {/* Press and drag to tilt the code toward your finger; it rests flat to scan. */}
      <TiltCard style={styles.qr}>
        <QRCode
          value={`ethereum:${ADDRESS}`}
          size={QR_SIZE}
          color={c.primary}
          center={
            <View style={styles.qrCenter}>
              <Avatar name={profile.name} size={50} uri={profile.photo} seed={profile.avatarSeed} />
            </View>
          }
        />
      </TiltCard>

      <Pressable onPress={copy} style={styles.addressBox}>
        <View style={styles.addressLabelRow}>
          <Text style={styles.addressLabel}>Wallet address</Text>
          <IconSwap name={copied ? 'check' : 'copy'} size={12} color={c.textSecondary} />
        </View>
        <Text style={styles.address}>{ADDRESS}</Text>
      </Pressable>

      <Pressable
        onPress={() => {
          tap();
          router.push('/networks');
        }}
        style={styles.networks}
      >
        <Text style={styles.networksText}>Use this address to receive tokens on</Text>
        <View style={styles.networksRow}>
          <View style={styles.chainStack}>
            {CHAINS.slice(0, 3).map((ch, i) => (
              <View key={ch.name} style={i > 0 && styles.chainOverlap}>
                <TokenIcon symbol={ch.symbol} size={16} />
              </View>
            ))}
          </View>
          <Text style={styles.networksCount}>{CHAINS.length} networks</Text>
          <Icon name="info" size={13} color={c.textSecondary} />
        </View>
      </Pressable>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  top: {
    alignItems: 'center',
  },
  handle: {
    color: c.text,
    fontSize: 20,
    fontWeight: '500',
  },
  suffix: {
    color: c.textSecondary,
  },
  qr: {
    marginTop: 24,
  },
  qrCenter: {
    padding: 6,
    borderRadius: 40,
    backgroundColor: c.sheet,
  },
  addressBox: {
    marginTop: 28,
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 6,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.divider,
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
  },
  networksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chainStack: {
    flexDirection: 'row',
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
