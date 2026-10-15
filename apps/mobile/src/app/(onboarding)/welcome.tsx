import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  FlatList,
  Image,
  type ImageSourcePropType,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { BackIcon, ForwardIcon } from '@/components/onboarding/icons';
import { PillButton } from '@/components/onboarding/PillButton';
import { makeStyles, useTheme } from '@/theme';

// Hero art is 1290x1760: the top of a 430pt-wide @3x screen. Slides 2 and 3
// have a transparent gold object drawn over the fixed background gradient;
// slide 1 shows the logo instead.
const HERO_ASPECT = 1760 / 1290;
// Centre of the hero art, as a fraction of screen width.
const HERO_CENTER_Y = 900 / 1290;
// The background gradient reaches the canvas colour at this fraction of the hero.
const GRADIENT_END = 0.62;
// Slide 1's logo matches the lock and clock: about as tall, centred as low.
// The stacked lockup is 1.62x its mark height (mark + gap + wordmark).
const LOGO_MARK = 0.4; // mark height, as a fraction of screen width
const LOGO_CENTER_Y = 0.74;

type Slide = {
  key: string;
  /** A 1290x1760 transparent image, or `logo` for the Honey logo. */
  art: ImageSourcePropType | 'logo';
  /** Odd-indexed segments are highlighted. */
  title: string[];
  subtitle: string;
};

const SLIDES: Slide[] = [
  {
    key: 'honey',
    art: 'logo',
    title: ['All your crypto,\n', 'one wallet.'],
    subtitle: 'Bitcoin, Ethereum, Solana,\nTron and XRP, side by side.',
  },
  {
    key: 'protected',
    art: require('@/assets/images/onboarding/protected.png'),
    title: ['Only you\n', 'control your money.'],
    subtitle: 'Your keys never leave your phone.\nNot even we can touch your funds.',
  },
  {
    key: 'anytime',
    art: require('@/assets/images/onboarding/anytime.png'),
    title: ['The only quantum-\n', 'secure wallet.'],
    subtitle: "Quantum computers could break wallets\nsooner than you think. Honey won't.",
  },
];

export default function WelcomeScreen() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  // `?slide=1` opens on a given slide (0-based), e.g. from a deep link.
  const { slide } = useLocalSearchParams<{ slide?: string }>();
  const initialIndex = Math.min(Math.max(Number(slide) || 0, 0), SLIDES.length - 1);
  const [index, setIndex] = useState(initialIndex);
  const list = useRef<FlatList<Slide>>(null);
  const goTo = (i: number) => list.current?.scrollToIndex({ index: i, animated: true });

  const heroHeight = width * HERO_ASPECT;
  const bottomPad = Math.max(insets.bottom - 3, 16);
  // Footer stack from the bottom: terms (32) + 24 + button (50) + 29 + dots (8).
  const footerHeight = bottomPad + 143;

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    if (next !== index) setIndex(next);
  };

  return (
    <View style={styles.root}>
      <Svg width={width} height={heroHeight} style={styles.backdrop}>
        <Defs>
          <LinearGradient id="hero" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.heroTop} />
            <Stop offset={GRADIENT_END} stopColor={c.canvas} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#hero)" />
      </Svg>

      <FlatList
        ref={list}
        data={SLIDES}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyExtractor={(item) => item.key}
        extraData={index}
        initialScrollIndex={initialIndex}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item }) => (
          <View style={{ width }}>
            {item.art === 'logo' ? (
              <View
                style={[
                  styles.logo,
                  { top: width * (LOGO_CENTER_Y - (LOGO_MARK * 1.62) / 2), width },
                ]}
              >
                <HoneyLogo variant="stacked" height={width * LOGO_MARK} />
              </View>
            ) : (
              <Image source={item.art} style={[styles.hero, { width, height: heroHeight }]} />
            )}
            <View style={[styles.copy, { paddingBottom: footerHeight + 26 }]}>
              {/* The copy rises in once its slide settles; off-screen slides keep it hidden. */}
              {SLIDES[index] === item ? (
                <TextsReveal
                  id={item.key}
                  align="center"
                  first={<SlideTitle parts={item.title} />}
                  second={<Text style={styles.subtitle}>{item.subtitle}</Text>}
                />
              ) : (
                <View style={styles.hidden}>
                  <SlideTitle parts={item.title} />
                  <Text style={styles.subtitle}>{item.subtitle}</Text>
                </View>
              )}
            </View>
          </View>
        )}
      />

      {/* Arrows beside the art, so it's clear there are more slides. */}
      {index > 0 && (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Previous slide"
          hitSlop={10}
          onPress={() => goTo(index - 1)}
          style={[styles.arrow, styles.arrowLeft, { top: width * HERO_CENTER_Y - 30 }]}
        >
          <BackIcon size={48} weight={2.4} color={c.textSecondary} />
        </PressableScale>
      )}
      {index < SLIDES.length - 1 && (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Next slide"
          hitSlop={10}
          onPress={() => goTo(index + 1)}
          style={[styles.arrow, styles.arrowRight, { top: width * HERO_CENTER_Y - 30 }]}
        >
          <ForwardIcon size={48} weight={2.4} color={c.textSecondary} />
        </PressableScale>
      )}

      <View pointerEvents="box-none" style={[styles.footer, { paddingBottom: bottomPad }]}>
        <View style={styles.dots}>
          {SLIDES.map((slide, i) => (
            <View key={slide.key} style={[styles.dot, i === index && styles.dotActive]} />
          ))}
        </View>
        <PillButton label="Get Started" onPress={() => router.push('/email')} style={styles.cta} />
        <Text style={styles.terms}>
          By using this app, you agree to accept our{'\n'}
          <Text style={styles.termsLink}>Terms of Use</Text> and{' '}
          <Text style={styles.termsLink}>Privacy Policy</Text>.
        </Text>
      </View>
    </View>
  );
}

/** A slide title; odd-indexed parts are highlighted. */
function SlideTitle({ parts }: { parts: string[] }) {
  const styles = useStyles();
  return (
    <Text style={styles.title}>
      {parts.map((part, i) => (
        <Text key={part} style={i % 2 === 1 && styles.highlight}>
          {part}
        </Text>
      ))}
    </Text>
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
  arrow: {
    position: 'absolute',
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: {
    left: 0,
  },
  arrowRight: {
    right: 0,
  },
  logo: {
    position: 'absolute',
    left: 0,
    alignItems: 'center',
  },
  hero: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  copy: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: {
    color: c.text,
    fontSize: 35,
    lineHeight: 41,
    fontWeight: '600',
    letterSpacing: -1.7,
    textAlign: 'center',
  },
  hidden: {
    alignItems: 'center',
    opacity: 0,
  },
  highlight: {
    color: c.highlight,
  },
  subtitle: {
    marginTop: 15,
    color: c.textSecondary,
    fontSize: 18,
    lineHeight: 21.5,
    textAlign: 'center',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  dots: {
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.divider,
  },
  dotActive: {
    backgroundColor: c.primary,
  },
  cta: {
    marginTop: 29,
    width: 190,
  },
  terms: {
    marginTop: 24,
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.1,
    textAlign: 'center',
  },
  termsLink: {
    color: c.text,
  },
}));
