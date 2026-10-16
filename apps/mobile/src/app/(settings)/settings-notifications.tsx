import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  Keyframe,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { askForNotifications, notificationsAllowed } from '@/lib/push';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

const PREVIEW = [
  { title: 'Maya wants to send 50 USDC', body: 'Family · needs your approval' },
  { title: 'You received USDC', body: 'Received 100 USDC from swayam.honey' },
  { title: 'ETH is up 5.6%', body: 'Ethereum (ETH) is up to $3,249.55' },
  { title: 'Your Honey Jar hit 50%', body: 'Halfway to your "Summer trip" goal' },
];

// The preview cards rise in turn, 80ms apart, once the sheet has settled: a one-off
// permission prompt, so they may take 400ms on a strong ease-out.
// Under Reduce Motion the rise is dropped and only the fade remains (gentler, not
// zero): Reanimated would otherwise skip the entrance entirely.
const rise = (index: number, reduced: boolean) =>
  reduced
    ? FadeIn.duration(DURATION.fast)
        .delay(DURATION.fast + index * DURATION.stagger * 2)
        .reduceMotion(ReduceMotion.Never)
    : new Keyframe({
        0: { opacity: 0, transform: [{ translateY: DISTANCE.medium }] },
        100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
      })
        .duration(DURATION.verySlow)
        .delay(DURATION.fast + index * DURATION.stagger * 2);

/** Asks for notification permission, previewing the kind of alerts Honey sends. */
export default function NotificationsSheet() {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const c = useTheme();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    notificationsAllowed()
      .then(setAllowed)
      .catch(() => setAllowed(false));
  }, []);

  return (
    <SheetScreen
      contentStyle={styles.content}
      footer={
        <PillButton
          label={allowed ? 'Notifications are on' : 'Turn on notifications'}
          disabled={allowed === true}
          onPress={async () => {
            tap();
            // Ask in the app first; once iOS stops asking, Settings is the only way.
            if (await askForNotifications()) {
              setAllowed(true);
              showToast('Notifications on');
              closeSheet();
            } else Linking.openSettings();
          }}
        />
      }
    >
      <View style={styles.iconTile}>
        <Icon name="bell" size={22} color={c.text} />
      </View>
      <TextsReveal
        id="notifications"
        align="center"
        first={<Text style={styles.title}>Turn on notifications</Text>}
        second={
          <Text style={styles.body}>
            Approve shared-wallet payments the moment they're asked for, and stay updated on
            transactions and big price moves.
          </Text>
        }
      />

      <View style={styles.preview}>
        <View style={styles.phone}>
          <View style={styles.screen}>
            <Text style={styles.date}>Monday, June 6</Text>
            <Text style={styles.time}>9:41</Text>
          </View>
        </View>
        <View style={styles.cards}>
          {PREVIEW.map((n, i) => (
            <Animated.View key={n.title} entering={rise(i, reduceMotion)} style={styles.card}>
              <View style={styles.appIcon}>
                <HoneyLogo variant="mark" height={22} />
              </View>
              <View style={styles.flex}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {n.title}
                </Text>
                <Text style={styles.cardBody} numberOfLines={1}>
                  {n.body}
                </Text>
              </View>
            </Animated.View>
          ))}
        </View>
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    alignItems: 'center',
  },
  iconTile: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
    marginBottom: 14,
  },
  title: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  preview: {
    marginTop: 34,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  phone: {
    width: 230,
    height: 110,
    padding: 6,
    paddingBottom: 0,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    backgroundColor: c.raised,
  },
  screen: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 16,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: c.accentSurface,
    overflow: 'hidden',
  },
  date: {
    color: c.accentText,
    fontSize: 11,
    fontWeight: '500',
  },
  time: {
    color: c.accentText,
    fontSize: 46,
    fontWeight: '700',
    opacity: 0.6,
  },
  cards: {
    alignSelf: 'stretch',
    marginTop: -28,
    gap: 6,
    paddingHorizontal: 4,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  appIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  flex: {
    flex: 1,
  },
  cardTitle: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  cardBody: {
    marginTop: 2,
    color: c.text,
    fontSize: 14,
  },
}));
