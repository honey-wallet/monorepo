import { router } from 'expo-router';
import { useRef } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { Guide, riseIn } from '@/components/wallet/Guide';
import { showErrorToast, showToast } from '@/lib/toast';
import { createAccount } from '@/lib/vault';
import { addVaultWallet, nextBurnerLabel } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/** A honey icon on a soft honey disc, rising into place. */
function Art({ icon }: { icon: IconName }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.scene}>
      <Animated.View entering={riseIn(40)} style={styles.disc}>
        <Icon name={icon} size={64} color={c.accentText} />
      </Animated.View>
    </View>
  );
}

/** What a burner wallet is for, in three steps, then create one. */
export default function BurnerWalletSheet() {
  const creating = useRef(false);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    try {
      addVaultWallet(await createAccount(nextBurnerLabel(), true));
      showToast('Burner wallet created');
      router.dismissAll();
    } catch {
      showErrorToast('Couldn’t create burner wallet');
    } finally {
      creating.current = false;
    }
  };

  return (
    <Guide
      doneLabel="Create burner wallet"
      onDone={create}
      steps={[
        {
          title: 'Stay safe',
          body: "Use a burner wallet for sites you don't trust. Your main wallet's funds stay separate.",
          art: <Art icon="shield" />,
        },
        {
          title: 'Replace anytime',
          body: 'Burners are disposable. If a site looks suspicious, throw this one away and create a fresh one.',
          art: <Art icon="trash" />,
        },
        {
          title: 'Keep it light',
          body: 'Only move small amounts into a burner, just what you need for that site.',
          art: <Art icon="leaf" />,
        },
      ]}
    />
  );
}

const useStyles = makeStyles((c) => ({
  scene: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disc: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
