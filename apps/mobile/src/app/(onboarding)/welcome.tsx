import { router } from 'expo-router';
import { useId } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { HoneyMascot } from '@/components/logo/HoneyMascot';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { tap } from '@/lib/haptics';
import { DEVICE } from '@/lib/platform';
import { makeStyles, useTheme } from '@/theme';

/**
 * The first screen: the honey from the opening animation stays on, looking around,
 * with the two ways in. No carousel to swipe through first (the old three slides are
 * in components/onboarding/WelcomeSlides.tsx): every screen before the wallet exists
 * is a place to lose someone, so this one asks for a single choice.
 */
export default function WelcomeScreen() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  // review: a fixed gradient id collides in the browser, where every SVG shares one page.
  const heroId = `hero${useId().replace(/[^\w]/g, '')}`;

  const start = (mode: 'create' | 'restore') => {
    tap();
    router.push({ pathname: '/get-started', params: { mode } });
  };

  return (
    <View style={styles.root}>
      <Svg width={width} height={height * 0.62} style={styles.backdrop}>
        <Defs>
          {/* <LinearGradient id="hero" x1="0" y1="0" x2="0" y2="1"> */}
          <LinearGradient id={heroId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.heroTop} />
            <Stop offset="1" stopColor={c.canvas} />
          </LinearGradient>
        </Defs>
        {/* <Rect width="100%" height="100%" fill="url(#hero)" /> */}
        <Rect width="100%" height="100%" fill={`url(#${heroId})`} />
      </Svg>

      <View style={styles.hero}>
        <HoneyMascot width={Math.min(180, width * 0.44)} />
        <View style={styles.copy}>
          <TextsReveal
            id="welcome"
            align="center"
            first={
              <Text style={styles.title}>
                All your crypto,{'\n'}
                <Text style={styles.highlight}>one wallet.</Text>
              </Text>
            }
            second={
              <Text style={styles.subtitle}>
                Ethereum, Solana and more,{'\n'}safe on {DEVICE}.
              </Text>
            }
          />
        </View>
      </View>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <PillButton label="Create a new wallet" onPress={() => start('create')} />
        <PillButton
          label="I already have a wallet"
          variant="secondary"
          onPress={() => start('restore')}
          style={styles.second}
        />
        <Text style={styles.terms}>
          By continuing, you agree to our <Text style={styles.termsLink}>Terms of Use</Text> and{' '}
          <Text style={styles.termsLink}>Privacy Policy</Text>.
        </Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  copy: {
    marginTop: 36,
  },
  title: {
    color: c.text,
    fontSize: 35,
    lineHeight: 41,
    fontWeight: '600',
    letterSpacing: -1.7,
    textAlign: 'center',
  },
  highlight: {
    color: c.highlight,
  },
  subtitle: {
    marginTop: 14,
    color: c.textSecondary,
    fontSize: 18,
    lineHeight: 22,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: 24,
  },
  second: {
    marginTop: 12,
  },
  terms: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  termsLink: {
    color: c.text,
  },
}));
