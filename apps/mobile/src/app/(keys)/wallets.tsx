import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetRow, SheetScreen, SheetSection } from '@/components/sheets/Sheet';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatUsd, shortAddress } from '@/lib/mock-wallet';
import { hasVoted, useMultisigState, YOU } from '@/lib/multisig';
import { leaveSheetTo } from '@/lib/navigation';
import { useOnboarding } from '@/lib/onboarding';
import { isWeb } from '@/lib/platform';
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
  const shared = useMultisigState();
  const { added } = useWallets();
  const active = useActiveWallet();
  const { copied, copy: copyAddress } = useCopy(active.address);
  const wallets = allWallets(profile.name, added);
  const hardware = wallets.filter((w) => w.kind === 'hardware');
  // Wallets are on the device; their balances come from the network.
  const loading = useFirstLoad(LOADS.walletTotals);

  // Each group shows two wallets, then "+N more" (review: in the popup a long list hid
  // Add wallet). The wallet in use is always one of the two.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const group = (key: string, list: AddedWallet[]) => {
    if (list.length <= 2 || expanded[key]) return list.map(row);
    const ordered = [
      ...list.filter((w) => w.id === active.id),
      ...list.filter((w) => w.id !== active.id),
    ];
    const rest = ordered.slice(2);
    return (
      <>
        {ordered.slice(0, 2).map(row)}
        <MoreWallets
          wallets={rest}
          profile={profile}
          onPress={() => {
            tap();
            setExpanded((e) => ({ ...e, [key]: true }));
          }}
        />
      </>
    );
  };

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

  const settingsLabel = shared.multisigs[active.id] ? 'Shared wallet settings' : 'Wallet settings';
  const openSettings = () => {
    tap();
    // A shared wallet's settings are its own page: members and rules.
    if (shared.multisigs[active.id]) {
      leaveSheetTo({ pathname: '/multisig/[id]', params: { id: active.id } });
    } else {
      leaveSheetTo('/settings');
    }
  };

  const row = (w: AddedWallet) => {
    // Shared wallets show their live rule and how much is waiting for you.
    const m = shared.multisigs[w.id];
    const waiting = shared.proposals.filter(
      (p) => p.walletId === w.id && p.status === 'pending' && !hasVoted(p, YOU),
    ).length;
    return (
      <WalletRow
        key={w.id}
        wallet={m ? { ...w, threshold: [m.threshold, m.members.length] } : w}
        waiting={waiting}
        profile={profile}
        active={w.id === active.id}
        loading={loading}
        onPress={() => select(w)}
      />
    );
  };

  return (
    <SheetScreen scroll>
      {/* The tray draws its own close button now.
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={10}
        scaleTo={0.97}
        onPress={() => router.back()}
        style={styles.close}
      >
        <Icon name="close" size={14} color={c.textSecondary} />
      </PressableScale> */}
      {isWeb ? (
        // review: in the 600px popup the centred header and full-width settings button
        // pushed Add wallet below the fold. One row instead: face, name, address and a
        // small Settings pill, clear of the tray's close button.
        <View style={styles.currentRow}>
          <WalletAvatar wallet={active} profile={profile} size={48} />
          <View style={styles.currentText}>
            {/* One line beside the Settings pill: a long name ends in "…" rather than wrapping. */}
            <Text numberOfLines={1} style={styles.nameRow}>
              {active.label}
            </Text>
            <Pressable onPress={copyAddress} hitSlop={6} style={styles.addressRowWeb}>
              <Text style={styles.address}>{shortAddress(active.address, 6, 4)}</Text>
              <IconSwap name={copied ? 'check' : 'copy'} size={13} color={c.textSecondary} />
            </Pressable>
          </View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={settingsLabel}
            scaleTo={0.96}
            onPress={openSettings}
            style={styles.settingsPill}
          >
            <Icon name="settings" size={14} color={c.text} />
            <Text style={styles.settingsPillLabel}>Settings</Text>
          </PressableScale>
        </View>
      ) : (
        <>
          <View style={styles.current}>
            <WalletAvatar wallet={active} profile={profile} size={64} />
            <TextSwap text={active.label} style={styles.name} />
            <Pressable onPress={copyAddress} hitSlop={6} style={styles.addressRow}>
              <Text style={styles.address}>{shortAddress(active.address, 8, 6)}</Text>
              <IconSwap name={copied ? 'check' : 'copy'} size={14} color={c.textSecondary} />
            </Pressable>
          </View>

          <PillButton
            label={settingsLabel}
            variant="secondary"
            onPress={openSettings}
            style={styles.settingsButton}
          />
        </>
      )}

      <SheetSection title="Wallets" />
      {/* {wallets.filter((w) => w.kind === 'wallet').map(row)} */}
      {group(
        'wallets',
        wallets.filter((w) => w.kind === 'wallet'),
      )}

      <SheetSection title="Multisig wallets" />
      {/* {wallets.filter((w) => w.kind === 'multisig').map(row)} */}
      {group(
        'multisig',
        wallets.filter((w) => w.kind === 'multisig'),
      )}
      <SheetRow
        leading={
          <View style={styles.iconCircle}>
            <Icon name="multisig" size={17} color={c.textSecondary} />
          </View>
        }
        title="New shared wallet"
        onPress={() => {
          tap();
          leaveSheetTo('/multisig-new');
        }}
      />

      {/* Hardware wallets connect over Bluetooth or the camera: phone only for now. */}
      {isWeb ? null : (
        <>
          <SheetSection title="Hardware wallets" />
          {/* {hardware.map(row)} */}
          {group('hardware', hardware)}
          <SheetRow
            leading={
              <View style={styles.iconCircle}>
                <Icon name="hardware" size={17} color={c.textSecondary} />
              </View>
            }
            title="Connect a hardware wallet"
            onPress={() => open('/hardware-wallet')}
          />
        </>
      )}

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

/** "+N more": the hidden wallets' faces, overlapped, and a count. Tap to show them. */
function MoreWallets({
  wallets,
  profile,
  onPress,
}: {
  wallets: AddedWallet[];
  profile: Profile;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <SheetRow
      leading={
        <View style={styles.moreFaces}>
          {wallets.slice(0, 3).map((w, i) => (
            <View key={w.id} style={[styles.moreFace, i > 0 && styles.moreOverlap]}>
              <WalletAvatar wallet={w} profile={profile} size={22} />
            </View>
          ))}
        </View>
      }
      title={`+${wallets.length} more`}
      accessibilityLabel={`Show ${wallets.length} more wallets`}
      accessory={<Icon name="chevronDown" size={14} color={c.textSecondary} />}
      onPress={onPress}
    />
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
  waiting = 0,
  profile,
  active,
  loading,
  onPress,
}: {
  wallet: AddedWallet;
  /** Shared wallets: proposals waiting for your approval. */
  waiting?: number;
  profile: Profile;
  active: boolean;
  /** Balance still on its way: a bar stands in for it. */
  loading: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  // The main wallet is empty until its first deposit, as on Home.
  const { funded } = useOnboarding();
  const usd = wallet.id === 'main' && !funded ? 0 : wallet.usd;
  const kind = wallet.threshold
    ? waiting
      ? `${waiting} waiting · `
      : `${wallet.threshold[0]} of ${wallet.threshold[1]} · `
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
      // Shorter beside a prefix, so every row stays on one line and the list evenly spaced.
      subtitle={`${kind}${shortAddress(wallet.address, kind ? 4 : 8, kind ? 4 : 6)}`}
      value={loading ? undefined : formatUsd(usd)}
      accessory={
        <View style={styles.accessory}>
          {loading && <SkeletonBar width={64} height={14} />}
          <View style={styles.checkSlot}>
            {active && (
              <View style={styles.check}>
                <IconSwap name="check" size={11} color={c.onPrimary} />
              </View>
            )}
          </View>
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
  // Browser: the current wallet as one row (see the render).
  currentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    // Clear of the tray's close button, top right.
    paddingRight: 40,
    marginBottom: 4,
  },
  currentText: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  addressRowWeb: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  settingsPill: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: c.raised,
  },
  settingsPillLabel: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
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
  // The faces in "+N more", overlapped, as wide as a wallet's avatar.
  moreFaces: {
    width: 44,
    flexDirection: 'row',
    alignItems: 'center',
  },
  moreFace: {
    borderRadius: 13,
    borderWidth: 2,
    borderColor: c.sheet,
  },
  moreOverlap: {
    marginLeft: -12,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  accessory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
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
    marginTop: 0,
  },
  addCircle: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: c.divider,
  },
}));
