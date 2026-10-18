import Constants from 'expo-constants';
import { type Href, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetSection } from '@/components/sheets/Sheet';
import { PushedScreen } from '@/components/wallet/parts';
import { api } from '@/lib/api';
import { lockNow } from '@/lib/app-lock';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { setProfile, useProfile } from '@/lib/profile';
import { useSettings } from '@/lib/settings';
import { useActiveWallet } from '@/lib/wallets';
// import { showToast } from '@/lib/toast'; (with the other-wallets list)
import { makeStyles, useTheme } from '@/theme';

const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' } as const;

const AVATAR_CREDIT_URL = 'https://www.figma.com/community/file/1356575240759683500';

export default function SettingsScreen() {
  const styles = useStyles();
  const wallet = useActiveWallet();
  const c = useTheme();
  const profile = useProfile();
  const settings = useSettings();
  // Out for now, with the other-wallets list below:
  // const [showWallets, setShowWallets] = useState(false);
  // Null while the server is being checked; a bar stands in for the status.
  const [server, setServer] = useState<string | null>(null);
  // const wallets = otherWallets(profile.name);

  useEffect(() => {
    api
      .version()
      .then((info) => setServer(`Connected · v${info.version}`))
      .catch(() => setServer('Unreachable'));
  }, []);

  const open = (href: Href) => () => {
    tap();
    router.push(href);
  };

  // const switchWallet = (id: string, label: string) => {
  //   tap();
  //   setActiveWallet(id);
  //   showToast(`Switched to ${label}`);
  // };

  return (
    <PushedScreen title="Settings">
      <PressableRow onPress={open('/profile-edit')} style={[styles.profile, styles.gutter]}>
        <Avatar name={profile.name} size={52} uri={profile.photo} seed={profile.avatarSeed} />
        <View style={styles.flex}>
          <Text style={styles.profileName}>{profile.name}</Text>
          <Text style={styles.value}>{shortAddress(wallet.address, 8, 6)}</Text>
        </View>
        <Icon name="chevronRight" size={15} color={c.textSecondary} />
      </PressableRow>

      {/* Out for now: switching wallets lives in the wallet switcher on Home.
      {wallets.length > 0 && (
        <View style={styles.gutter}>
          <LabeledDivider
            label={wallets.length === 1 ? '1 other wallet' : `${wallets.length} other wallets`}
            open={showWallets}
            onPress={() => setShowWallets((v) => !v)}
          />
        </View>
      )}
      <Accordion open={showWallets && wallets.length > 0}>
        {wallets.map((w) => (
          <PressableRow
            key={w.id}
            onPress={() => switchWallet(w.id, w.label)}
            style={[styles.walletRow, styles.gutter]}
          >
            <Avatar name={w.label} size={32} seed={w.id} />
            <Text style={[styles.label, styles.flex]}>{w.label}</Text>
            <Text style={styles.value}>{shortAddress(w.address)}</Text>
          </PressableRow>
        ))}
      </Accordion>
      */}

      <View style={styles.gutter}>
        <SheetSection title="Preferences" />
        {isWeb ? null : (
          <SheetRow
            icon="grid"
            title="App icon"
            onPress={open('/settings-app-icon')}
            accessory="chevron"
          />
        )}
        <SheetRow
          icon="theme"
          title="Theme"
          value={THEME_LABEL[settings.theme]}
          onPress={open('/settings-theme')}
          accessory="chevron"
        />
        <SheetRow
          icon="currency"
          title="Local currency"
          value={settings.currency}
          onPress={open('/settings-currency')}
          accessory="chevron"
        />
        <SheetRow
          icon="language"
          title="Language"
          value={settings.language}
          onPress={open('/settings-language')}
          accessory="chevron"
        />
        {isWeb ? null : (
          <SheetRow
            icon="bell"
            title="Notifications"
            onPress={open('/settings-notifications')}
            accessory="chevron"
          />
        )}
        <SheetRow
          icon="chart"
          title="Balances and activity"
          onPress={open('/settings-balances')}
          accessory="chevron"
        />
        {isWeb ? null : (
          <SheetRow
            icon="haptics"
            title="Haptic touch"
            accessory={
              <Toggle
                accessibilityLabel="Haptic touch"
                value={profile.haptics}
                onValueChange={(haptics) => {
                  setProfile({ haptics });
                  tap();
                }}
              />
            }
          />
        )}
        <SheetRow
          icon="advanced"
          title="Advanced"
          onPress={open('/settings-advanced')}
          accessory="chevron"
        />

        <SheetSection title="Privacy and security" />
        {isWeb ? null : (
          <SheetRow
            icon="faceId"
            title="Face ID"
            onPress={open('/settings-face-id')}
            accessory="chevron"
          />
        )}
        <SheetRow
          icon="recovery"
          title="Recovery phrase"
          onPress={open('/recovery-phrase')}
          accessory="chevron"
        />
        {isWeb ? (
          <SheetRow
            icon="qr"
            title="Send wallet to phone"
            onPress={open({ pathname: '/pair-phone', params: { send: '1' } })}
            accessory="chevron"
          />
        ) : null}
        {isWeb ? (
          <SheetRow
            icon="globe"
            title="Connected sites"
            onPress={open('/connected-sites')}
            accessory="chevron"
          />
        ) : null}
        {isWeb ? (
          <SheetRow
            icon="lock"
            title="Lock Honey"
            onPress={() => {
              tap();
              void lockNow();
            }}
          />
        ) : null}
        {isWeb ? null : (
          <SheetRow
            icon="cloud"
            title="Cloud backup"
            onPress={open('/icloud-backup')}
            accessory="chevron"
          />
        )}
        <SheetRow
          icon="permissions"
          title="Permissions"
          onPress={open('/settings-permissions')}
          accessory="chevron"
        />

        <SheetSection title="Support" />
        <SheetRow icon="help" title="Help center" onPress={open('/help')} accessory="chevron" />
        <SheetRow icon="mail" title="Contact us" onPress={open('/contact')} accessory="chevron" />

        <SheetSection title="About" />
        <SheetRow icon="book" title="About" onPress={open('/settings-about')} accessory="chevron" />
        <SheetRow
          icon="sparkles"
          title="Motion gallery"
          onPress={open('/motion-gallery')}
          accessory="chevron"
        />
        <SheetRow icon="info" title="Version" value={Constants.expoConfig?.version ?? '—'} />
        <SheetRow
          icon="server"
          title="Server"
          accessory={
            server === null ? (
              <SkeletonBar width={120} height={14} />
            ) : (
              <TextSwap text={server} style={styles.value} />
            )
          }
        />
        {/* Last, on its own: the one thing in Settings that can't be undone from here. */}
        <PressableScale
          accessibilityRole="button"
          scaleTo={0.98}
          onPress={open('/sign-out')}
          style={styles.signOut}
        >
          <Text style={styles.signOutLabel}>Sign out</Text>
        </PressableScale>
        <Text style={styles.credit} onPress={() => Linking.openURL(AVATAR_CREDIT_URL)}>
          Avatars: “Dylan” by Natalia Spivak, CC BY 4.0, generated with DiceBear.
        </Text>
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  signOut: {
    marginTop: 28,
    height: 52,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
  },
  signOutLabel: {
    color: c.error,
    fontSize: 17,
    fontWeight: '600',
  },
  gutter: {
    paddingHorizontal: 20,
  },
  flex: {
    flex: 1,
  },
  profile: {
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  profileName: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  label: {
    color: c.text,
    fontSize: 17,
  },
  value: {
    marginRight: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  credit: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
}));
