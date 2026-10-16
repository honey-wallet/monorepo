import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { HeaderIconButton, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { shortAddress } from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import { allWallets, useWallets } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/** Turn smart wallet features on or off for each of the user's wallets. */
export default function SmartWalletScreen() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const { added } = useWallets();
  const wallets = allWallets(profile.name, added);
  // Demo state: every wallet but the main one starts as a smart wallet.
  const [inactive, setInactive] = useState<Set<string>>(() => new Set(['main']));
  // Whether a wallet is smart is read from its account on chain.
  const loading = useFirstLoad(LOADS.smartWallets);

  const toggle = (id: string, label: string) => {
    tap();
    const turningOn = inactive.has(id);
    const next = new Set(inactive);
    if (turningOn) next.delete(id);
    else next.add(id);
    setInactive(next);
    showToast(`Smart wallet ${turningOn ? 'on' : 'off'} for ${label}`);
  };

  return (
    <PushedScreen
      title="Smart wallet"
      fallback="/settings"
      right={
        <HeaderIconButton
          bare
          icon="help"
          label="What are smart wallets?"
          onPress={() => router.push('/smart-wallet-info')}
        />
      }
    >
      {wallets.map((w) => {
        const active = !inactive.has(w.id);
        return (
          <PressableRow
            key={w.id}
            accessibilityRole="switch"
            accessibilityState={{ checked: active }}
            accessibilityLabel={`${w.label}, smart wallet ${loading ? 'loading' : active ? 'active' : 'inactive'}`}
            disabled={loading}
            onPress={() => toggle(w.id, w.label)}
            style={styles.row}
          >
            <Avatar
              name={w.label}
              size={44}
              seed={w.id === 'main' ? profile.avatarSeed : w.id}
              uri={w.id === 'main' ? profile.photo : null}
            />
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {w.label}
              </Text>
              <Text style={styles.address}>{shortAddress(w.address)}</Text>
            </View>
            {loading ? (
              <SkeletonBar width={56} height={14} />
            ) : (
              <TextSwap
                text={active ? 'Active' : 'Inactive'}
                style={[styles.status, active && styles.statusActive]}
              />
            )}
            <Icon name="chevronRight" size={15} color={c.textSecondary} />
          </PressableRow>
        );
      })}
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  name: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  address: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  status: {
    marginRight: 4,
    color: c.textSecondary,
    fontSize: 16,
  },
  statusActive: {
    color: c.accentText,
  },
}));
