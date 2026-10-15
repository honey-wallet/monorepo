import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetRow, SheetScreen, SheetSection } from '@/components/wallet/Sheet';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { formatUsd, shortAddress } from '@/lib/mock-wallet';
import { type Profile, useProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import {
  type AddedWallet,
  allWallets,
  setActiveWallet,
  useActiveWallet,
  useWallets,
} from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/** Wallet switcher, presented as a sheet over the home screen. */
export default function WalletsSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const { added } = useWallets();
  const active = useActiveWallet();
  const { copied, copy: copyAddress } = useCopy(active.address);
  const wallets = allWallets(profile.name, added);
  const hardware = wallets.filter((w) => w.kind === 'hardware');

  const select = (wallet: AddedWallet) => {
    tap();
    setActiveWallet(wallet.id);
    showToast(`Switched to ${wallet.label}`);
    closeSheet();
  };

  const open = (path: '/add-wallet' | '/hardware-wallet') => {
    tap();
    router.push(path);
  };

  const row = (w: AddedWallet) => (
    <WalletRow
      key={w.id}
      wallet={w}
      profile={profile}
      active={w.id === active.id}
      onPress={() => select(w)}
    />
  );

  return (
    <SheetScreen scroll>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={10}
        scaleTo={0.97}
        onPress={() => router.back()}
        style={styles.close}
      >
        <Icon name="close" size={14} color={c.textSecondary} />
      </PressableScale>
      <View style={styles.current}>
        <WalletAvatar wallet={active} profile={profile} size={64} />
        <TextSwap text={active.label} style={styles.name} />
        <Pressable onPress={copyAddress} hitSlop={6} style={styles.addressRow}>
          <Text style={styles.address}>{shortAddress(active.address, 8, 6)}</Text>
          <IconSwap name={copied ? 'check' : 'copy'} size={14} color={c.textSecondary} />
        </Pressable>
      </View>

      <PillButton
        label="Wallet settings"
        variant="secondary"
        onPress={() => {
          tap();
          router.dismiss();
          router.push('/settings');
        }}
        style={styles.settingsButton}
      />

      <SheetSection title="Wallets" />
      {wallets.filter((w) => w.kind === 'wallet').map(row)}

      <SheetSection title="Multisig wallets" />
      {wallets.filter((w) => w.kind === 'multisig').map(row)}

      <SheetSection title="Hardware wallets" />
      {hardware.map(row)}
      <SheetRow
        leading={
          <View style={styles.iconCircle}>
            <Icon name="hardware" size={17} color={c.textSecondary} />
          </View>
        }
        title="Connect a hardware wallet"
        onPress={() => open('/hardware-wallet')}
      />

      <View style={styles.addRow}>
        <SheetRow
          leading={
            <View style={[styles.iconCircle, styles.addCircle]}>
              <Icon name="plus" size={17} color={c.text} />
            </View>
          }
          title="Add wallet"
          onPress={() => open('/add-wallet')}
        />
      </View>
    </SheetScreen>
  );
}

/** The user's own wallet shows their profile photo; others get a generated face. */
function WalletAvatar({
  wallet,
  profile,
  size,
}: {
  wallet: AddedWallet;
  profile: Profile;
  size: number;
}) {
  return wallet.id === 'main' ? (
    <Avatar name={wallet.label} size={size} uri={profile.photo} seed={profile.avatarSeed} />
  ) : (
    <Avatar name={wallet.label} size={size} seed={wallet.id} />
  );
}

function WalletRow({
  wallet,
  profile,
  active,
  onPress,
}: {
  wallet: AddedWallet;
  profile: Profile;
  active: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const kind = wallet.threshold
    ? `${wallet.threshold[0]} of ${wallet.threshold[1]} · `
    : wallet.watchOnly
      ? 'Watching · '
      : wallet.burner
        ? 'Burner · '
        : '';
  const badge = wallet.threshold
    ? 'multisig'
    : wallet.watchOnly
      ? 'eye'
      : wallet.burner
        ? 'flame'
        : null;
  return (
    <SheetRow
      accessibilityLabel={`${wallet.label}${active ? ', current wallet' : ''}`}
      selected={active}
      onPress={onPress}
      leading={
        <View>
          <WalletAvatar wallet={wallet} profile={profile} size={40} />
          {badge && (
            <View style={styles.badge}>
              <Icon name={badge} size={9} color={c.text} />
            </View>
          )}
        </View>
      }
      title={wallet.label}
      subtitle={`${kind}${shortAddress(wallet.address, 8, 6)}`}
      value={formatUsd(wallet.usd)}
      accessory={
        <View style={styles.checkSlot}>
          {active && (
            <View style={styles.check}>
              <IconSwap name="check" size={11} color={c.onPrimary} />
            </View>
          )}
        </View>
      }
    />
  );
}

const useStyles = makeStyles((c) => ({
  close: {
    position: 'absolute',
    top: 18,
    right: 18,
    zIndex: 1,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  current: {
    alignItems: 'center',
  },
  name: {
    marginTop: 10,
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
  },
  addressRow: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  address: {
    color: c.textSecondary,
    fontSize: 15,
  },
  settingsButton: {
    marginTop: 20,
  },
  // Wallet rows match SheetRow's metrics but keep their own accessibility label.
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 19,
    height: 19,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
    borderWidth: 2,
    borderColor: c.card,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  checkSlot: {
    width: 20,
    alignItems: 'flex-end',
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  addRow: {
    marginTop: 14,
  },
  addCircle: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: c.divider,
  },
}));
