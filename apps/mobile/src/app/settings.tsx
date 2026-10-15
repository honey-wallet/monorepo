import Constants from 'expo-constants';
import { type Href, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { PressableRow } from '@/components/motion/PressableRow';
import { TextSwap } from '@/components/motion/TextSwap';
import { Toggle } from '@/components/motion/Toggle';
import { LabeledDivider, PushedScreen } from '@/components/wallet/parts';
import { SheetRow, SheetSection } from '@/components/wallet/Sheet';
import { api } from '@/lib/api';
import { tap } from '@/lib/haptics';
import { ADDRESS, otherWallets, shortAddress } from '@/lib/mock-wallet';
import { setProfile, useProfile } from '@/lib/profile';
import { useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { setActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' } as const;
const BACKUP_LABEL = Platform.OS === 'android' ? 'Google Drive backup' : 'iCloud backup';

const AVATAR_CREDIT_URL = 'https://www.figma.com/community/file/1356575240759683500';

export default function SettingsScreen() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const settings = useSettings();
  const [showWallets, setShowWallets] = useState(false);
  const [server, setServer] = useState('Checking…');
  const wallets = otherWallets(profile.name);

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

  const switchWallet = (id: string, label: string) => {
    tap();
    setActiveWallet(id);
    showToast(`Switched to ${label}`);
  };

  return (
    <PushedScreen title="Settings">
      <PressableRow onPress={open('/profile-edit')} style={[styles.profile, styles.gutter]}>
        <Avatar name={profile.name} size={52} uri={profile.photo} seed={profile.avatarSeed} />
        <View style={styles.flex}>
          <Text style={styles.profileName}>{profile.name}</Text>
          <Text style={styles.value}>{shortAddress(ADDRESS, 8, 6)}</Text>
        </View>
        <Icon name="chevronRight" size={15} color={c.textSecondary} />
      </PressableRow>

      <View style={styles.gutter}>
        <LabeledDivider
          label={`${wallets.length} other wallets`}
          open={showWallets}
          onPress={() => setShowWallets((v) => !v)}
        />
      </View>
      <Accordion open={showWallets}>
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

      <View style={styles.gutter}>
        <SheetSection title="Preferences" />
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
        <SheetRow
          icon="bell"
          title="Notifications"
          onPress={open('/settings-notifications')}
          accessory="chevron"
        />
        <SheetRow
          icon="chart"
          title="Balances and activity"
          onPress={open('/settings-balances')}
          accessory="chevron"
        />
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
        <SheetRow
          icon="advanced"
          title="Advanced"
          onPress={open('/settings-advanced')}
          accessory="chevron"
        />

        <SheetSection title="Privacy and security" />
        <SheetRow
          icon="faceId"
          title="Face ID"
          onPress={open('/settings-face-id')}
          accessory="chevron"
        />
        <SheetRow
          icon="recovery"
          title="Recovery phrase"
          onPress={open('/recovery-phrase')}
          accessory="chevron"
        />
        <SheetRow
          icon="cloud"
          title={BACKUP_LABEL}
          onPress={open('/icloud-backup')}
          accessory="chevron"
        />
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
        <SheetRow icon="info" title="Version" value={Constants.expoConfig?.version ?? '—'} />
        <SheetRow
          icon="server"
          title="Server"
          accessory={<TextSwap text={server} style={styles.value} />}
        />
        <Text style={styles.credit} onPress={() => Linking.openURL(AVATAR_CREDIT_URL)}>
          Avatars: “Dylan” by Natalia Spivak, CC BY 4.0, generated with DiceBear.
        </Text>
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
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
