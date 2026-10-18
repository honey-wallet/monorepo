import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { isWeb } from '@/lib/platform';
import { makeStyles, useTheme } from '@/theme';
import { BackIcon, CloseIcon, HelpIcon } from './icons';

type Props = {
  title: string;
  /** `close` for the first step after the welcome carousel, `back` afterwards. */
  leading?: 'close' | 'back';
  children: ReactNode;
  /** Buttons pinned above the keyboard. */
  footer: ReactNode;
  /** What the "?" button explains; steps with nothing to explain hide it. */
  help?: HelpTopic;
};

/** Topics the onboarding help sheet (`/step-help`) can explain. */
export type HelpTopic = 'email' | 'phone' | 'code';

/** Shared chrome for the onboarding form steps. */
export function StepScreen({ title, leading = 'back', children, footer, help }: Props) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { marginTop: insets.top + 4 }]}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={leading === 'close' ? 'Close' : 'Back'}
          hitSlop={8}
          onPress={() => goBackOr('/welcome')}
          style={styles.iconButton}
        >
          {leading === 'close' ? <CloseIcon color={c.text} /> : <BackIcon color={c.text} />}
        </PressableScale>
        {help && (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Help"
            hitSlop={8}
            onPress={() => {
              tap();
              router.push({ pathname: '/step-help', params: { topic: help } });
            }}
            style={styles.iconButton}
          >
            <HelpIcon size={29} color={c.text} />
          </PressableScale>
        )}
      </View>

      <View style={styles.content}>
        <TextsReveal id={title} first={<Text style={styles.title}>{title}</Text>} />
        {children}
      </View>

      <View style={[styles.footer, { marginBottom: Math.max(insets.bottom, 34) }]}>{footer}</View>
    </KeyboardAvoidingView>
  );
}

/** Styles shared by the individual step screens. */
export const useStepStyles = makeStyles((c) => ({
  input: {
    marginTop: 26,
    paddingVertical: 0,
    height: 30,
    color: c.text,
    fontSize: 22,
    fontWeight: '500',
  },
  hint: {
    marginTop: 22,
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.2,
  },
  footerRow: {
    flexDirection: 'row',
    // review: tighter in the 393px popup, where "Choose Photo" wrapped onto two lines.
    gap: isWeb ? 12 : 17,
  },
  footerButton: {
    flex: 1,
  },
}));

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.divider,
  },
  content: {
    flex: 1,
    paddingHorizontal: 48,
    paddingTop: 44,
  },
  title: {
    color: c.text,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  footer: {
    // Wider in the popup, so two buttons in a row keep their labels on one line.
    paddingHorizontal: isWeb ? 24 : 40,
  },
}));
