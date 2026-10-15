import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { LabeledRule } from '@/components/wallet/parts';
import { SheetScreen, SheetText } from '@/components/wallet/Sheet';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { ADDRESS, shortAddress } from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { makeStyles, useTheme } from '@/theme';

/** Receive sheet: your address to copy or show as a QR code. */
export default function ReceiveSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const { copied, copy } = useCopy(ADDRESS);
  const [showExchange, setShowExchange] = useState(false);

  return (
    <SheetScreen title="Receive crypto">
      <SheetText>Fund your wallet by transferring crypto from another wallet or account</SheetText>

      <View style={[styles.card, styles.firstCard]}>
        <Avatar name={profile.name} size={44} uri={profile.photo} seed={profile.avatarSeed} />
        <View style={styles.flex}>
          <Text style={styles.name}>{profile.name}</Text>
          <Text style={styles.address}>{shortAddress(ADDRESS, 8, 6)}</Text>
        </View>
        <PressableScale
          accessibilityLabel="Copy address"
          scaleTo={0.9}
          onPress={copy}
          style={styles.round}
        >
          <IconSwap name={copied ? 'check' : 'copy'} size={15} color={c.text} />
        </PressableScale>
        <PressableScale
          accessibilityLabel="Show QR code"
          scaleTo={0.9}
          onPress={() => {
            tap();
            router.push('/my-qr');
          }}
          style={styles.round}
        >
          <Icon name="qr" size={15} color={c.text} />
        </PressableScale>
      </View>

      <LabeledRule label="From an account" />
      <PressableRow
        accessibilityState={{ expanded: showExchange }}
        onPress={() => {
          tap();
          setShowExchange((v) => !v);
        }}
        style={styles.card}
      >
        <View style={styles.exchange}>
          <Icon name="bank" size={18} color={c.accentText} />
        </View>
        <Text style={[styles.name, styles.flex]}>From an exchange</Text>
        <AccordionChevron open={showExchange} size={13} color={c.textSecondary} />
      </PressableRow>
      <Accordion open={showExchange}>
        <View style={styles.steps}>
          {[
            'Copy your Honey address.',
            'In your exchange, choose Withdraw and paste it as the destination.',
            'Pick the matching network, then confirm. Funds usually arrive in minutes.',
          ].map((step, i) => (
            <View key={step} style={styles.step}>
              <Text style={styles.stepNumber}>{i + 1}</Text>
              <Text style={[styles.stepText, styles.flex]}>{step}</Text>
            </View>
          ))}
          <PillButton
            label={copied ? 'Copied' : 'Copy address'}
            variant="secondary"
            onPress={copy}
          />
        </View>
      </Accordion>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.divider,
  },
  firstCard: {
    marginTop: 8,
  },
  name: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  address: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  steps: {
    paddingTop: 14,
    gap: 12,
  },
  step: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 22,
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 13,
    fontWeight: '600',
  },
  stepText: {
    color: c.text,
    fontSize: 15,
    lineHeight: 21,
  },
  exchange: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
