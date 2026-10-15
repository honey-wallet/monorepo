import { Platform, Text, View } from 'react-native';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { updateSettings, useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const SERVICE = Platform.OS === 'android' ? 'Google Drive' : 'iCloud';
const ACCOUNT = Platform.OS === 'android' ? 'Google account' : 'iCloud account';

/**
 * Cloud backup of the recovery phrase. The backup is encrypted on the device before it
 * leaves; Honey's server never sees it.
 */
export default function CloudBackupScreen() {
  const styles = useStyles();
  const c = useTheme();
  const { backedUp } = useSettings();

  const remove = () => {
    tap();
    updateSettings({ backedUp: false });
    showToast(`${SERVICE} backup deleted`);
  };

  const backUp = () => {
    tap();
    updateSettings({ backedUp: true });
    showToast(`Backed up to ${SERVICE}`);
  };

  return (
    <PushedScreen
      title={`${SERVICE} backup`}
      fallback="/settings"
      scroll={false}
      contentStyle={styles.content}
      footer={
        <PressableScale
          accessibilityRole="button"
          onPress={backedUp ? remove : backUp}
          scaleTo={0.98}
          style={[styles.button, { backgroundColor: backedUp ? `${c.error}22` : c.primary }]}
        >
          <TextSwap
            text={backedUp ? 'Delete backup' : 'Back up now'}
            style={[styles.buttonLabel, { color: backedUp ? c.error : c.onPrimary }]}
          />
        </PressableScale>
      }
    >
      <Text style={styles.body}>
        By having your recovery phrase backed up to {SERVICE}, you can recover your wallet just by
        being logged into your {ACCOUNT} on any device. It's encrypted on this device first, so only
        you can read it.
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>Recovery phrase</Text>
        <TextSwap text={backedUp ? 'Backed up' : 'Not backed up'} style={styles.status} />
        <IconSwap
          name={backedUp ? 'check' : 'warning'}
          size={18}
          color={backedUp ? c.success : c.error}
        />
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  body: {
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: 23,
  },
  row: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  label: {
    flex: 1,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  status: {
    color: c.textSecondary,
    fontSize: 16,
  },
  button: {
    flex: 1,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    fontSize: 19,
    fontWeight: '600',
  },
}));
