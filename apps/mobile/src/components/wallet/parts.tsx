import type { Href } from 'expo-router';
import { type ReactNode, useEffect, useMemo } from 'react';
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedProps,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Mask, Path, Rect, Stop, SvgXml } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { AccordionChevron } from '@/components/motion/Accordion';
import { IconSwap } from '@/components/motion/IconSwap';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { useEntrancePlaying } from '@/components/motion/Rise';
import { StickyArea } from '@/components/motion/Sticky';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { NETWORK_LOGOS } from '@/components/wallet/network-logos';
import { TOKEN_LOGOS } from '@/components/wallet/token-logos';
import { tap } from '@/lib/haptics';
import { CHAINS, type Chain, chainSymbol, formatUsd, type Token } from '@/lib/mock-wallet';
import { goBackOr } from '@/lib/navigation';
import { HIDDEN_AMOUNT, toggleHideBalance, useSettings } from '@/lib/settings';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/**
 * The token's full-colour coin logo; unknown tokens get their initial in a grey well. With
 * `chain`, a small network badge sits bottom-right, as in Uniswap, unless the token
 * is that network's own coin (ETH on Ethereum needs no badge).
 */
export function TokenIcon({
  symbol,
  size = 40,
  chain,
  ring,
}: {
  symbol: string;
  size?: number;
  chain?: Chain;
  /** Colour around the badge; match the surface behind the icon. */
  ring?: string;
}) {
  const c = useTheme();
  const xml = TOKEN_LOGOS[symbol] ?? NETWORK_LOGOS[symbol];
  // A token without a logo gets its initial in a grey well, so rows still tell apart.
  const logo = xml ? (
    <SvgXml xml={xml} width={size} height={size} />
  ) : (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.raised,
      }}
    >
      <Text style={{ color: c.textSecondary, fontSize: size * 0.42, fontWeight: '600' }}>
        {symbol.charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
  // Any token given a network wears its badge, its own chain's coin included (ETH on
  // Ethereum), so every row and chip says where the token is.
  const network = chain ? chainSymbol(chain) : undefined;
  if (!network) return logo;
  const badge = Math.round(size * 0.42);
  return (
    <View style={{ width: size, height: size }}>
      {logo}
      <View
        style={{
          position: 'absolute',
          right: -3,
          bottom: -3,
          padding: 2,
          borderRadius: badge / 3,
          backgroundColor: ring ?? c.card,
        }}
      >
        <SvgXml xml={TOKEN_LOGOS[network] ?? TOKEN_LOGOS.GENERIC} width={badge} height={badge} />
      </View>
    </View>
  );
}

/** "All networks": the first four network logos in a 2×2 grid, as in Uniswap. */
export function NetworkGrid({ size }: { size: number }) {
  const cell = size / 2 - 1;
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}>
      {CHAINS.slice(0, 4).map((chain) => (
        <TokenIcon key={chain.name} symbol={chain.symbol} size={cell} />
      ))}
    </View>
  );
}

/** Up/down change in percent; only the triangle is coloured, as in Uniswap. */
export function Change({ value, size = 15 }: { value: number; size?: number }) {
  const c = useTheme();
  const color = value < 0 ? c.error : c.success;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <Icon name={value < 0 ? 'down' : 'up'} size={size * 0.6} color={color} />
      <Text
        style={{ color: c.textSecondary, fontSize: size }}
      >{`${Math.abs(value).toFixed(2)}%`}</Text>
    </View>
  );
}

export function TokenRow({ token, onPress }: { token: Token; onPress?: () => void }) {
  const styles = useStyles();
  return (
    <PressableRow onPress={onPress} style={styles.tokenRow}>
      <TokenIcon symbol={token.symbol} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{token.name}</Text>
        <Text style={styles.rowSubtitle}>
          {token.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} {token.symbol}
        </Text>
      </View>
      <View style={styles.rowEnd}>
        <Text style={styles.rowTitle}>{formatUsd(token.usd)}</Text>
        <Change value={token.change} />
      </View>
    </PressableRow>
  );
}

/** A thin rule with a centred label; it heads an accordion, so its chevron flips. */
export function LabeledDivider({
  label,
  open,
  onPress,
}: {
  label: string;
  open: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.divider}
      hitSlop={8}
    >
      <View style={styles.rule} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <AccordionChevron open={open} size={11} color={c.textSecondary} />
      <View style={styles.rule} />
    </Pressable>
  );
}

/** A thin rule with a centred label and nothing to tap, e.g. "From an account". */
export function LabeledRule({ label }: { label: string }) {
  const styles = useStyles();
  return (
    <View style={styles.divider}>
      <View style={styles.rule} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.rule} />
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The sparkline draws in just after the balance beside it has landed. */
const SPARK_DRAW = { duration: DURATION.medium, easing: EASE.smoothOut } as const;
const SPARK_DELAY = DURATION.stagger * 2;

/**
 * Balance sparkline after Uniswap: a thin line that fades in from the left, over
 * a faint glow that fades the same way, so the chart has no hard left edge. On a
 * screen's first-visit entrance the line draws itself in left to right and the glow
 * follows; under Reduce Motion it fades in whole.
 */
export function Sparkline({
  data,
  width,
  height,
}: {
  data: number[];
  width: number;
  height: number;
}) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const { play, revealed } = useEntrancePlaying();
  const { line, length } = useMemo(() => {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const points = data.map((v, i) => [
      (i / (data.length - 1)) * width,
      3 + (1 - (v - min) / span) * (height - 6),
    ]);
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return {
      line: points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
      length: len,
    };
  }, [data, width, height]);
  const color = data[data.length - 1] < data[0] ? c.error : c.success;

  const drawn = useSharedValue(play ? 0 : 1);
  useEffect(() => {
    if (!play || !revealed) return;
    drawn.value = withDelay(
      SPARK_DELAY,
      withTiming(1, reduceMotion ? { duration: DURATION.fast, easing: EASE.ease } : SPARK_DRAW),
    );
  }, [play, revealed, reduceMotion, drawn]);
  const lineProps = useAnimatedProps(() =>
    reduceMotion
      ? { strokeDashoffset: 0, strokeOpacity: drawn.value }
      : { strokeDashoffset: length * (1 - drawn.value), strokeOpacity: 1 },
  );
  // The glow trails the line, filling in over the back half of the draw.
  const glowProps = useAnimatedProps(() => ({
    opacity: reduceMotion ? drawn.value : Math.max(0, drawn.value * 2 - 1),
  }));

  return (
    <Svg width={width} height={height}>
      <Defs>
        {/* Horizontal fade shared by the line and the glow. */}
        <LinearGradient id="sparkFadeIn" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={color} stopOpacity={0.15} />
          <Stop offset="0.4" stopColor={color} stopOpacity={1} />
        </LinearGradient>
        <LinearGradient id="sparkGlow" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.14} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="sparkMaskFade" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#fff" stopOpacity={0} />
          <Stop offset="0.6" stopColor="#fff" stopOpacity={1} />
        </LinearGradient>
        <Mask id="sparkMask">
          <Rect width={width} height={height} fill="url(#sparkMaskFade)" />
        </Mask>
      </Defs>
      <AnimatedPath
        d={`${line} L${width} ${height} L0 ${height} Z`}
        fill="url(#sparkGlow)"
        mask="url(#sparkMask)"
        animatedProps={glowProps}
      />
      <AnimatedPath
        d={line}
        stroke="url(#sparkFadeIn)"
        strokeWidth={1.5}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={[length, length]}
        animatedProps={lineProps}
      />
    </Svg>
  );
}

/** Standard spacing for full-screen pushed pages (the counterpart of `SHEET`). */
export const SCREEN = {
  gutter: 20,
  /** Space under scrolling content, above the home indicator. */
  bottom: 32,
  /** Footer padding above and below its buttons (bottom adds the safe area). */
  footerTop: 12,
  footerBottom: 12,
} as const;

/**
 * Header for pushed screens: back chevron, centred title, optional buttons on the
 * right. `title` can be text or an element (e.g. a token logo with its symbol).
 */
export function ScreenHeader({
  title,
  fallback = '/home',
  right,
}: {
  title: ReactNode;
  /** Where Back goes when there's nothing to go back to. */
  fallback?: Href;
  right?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        <HeaderIconButton bare icon="chevronLeft" label="Back" onPress={() => goBackOr(fallback)} />
      </View>
      {typeof title === 'string' ? (
        <Text style={styles.headerTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : (
        <View style={styles.headerTitleRow}>{title}</View>
      )}
      <View style={[styles.headerSide, styles.headerEnd]}>{right}</View>
    </View>
  );
}

/** Size of every header button, and the height of anything sitting beside one. */
export const HEADER_BUTTON = 36;

/**
 * The standard header button: an icon in a raised circle. Used for every top-bar
 * action (back, settings, notifications, scan, help, +) so they all match. The icon
 * cross-fades when `icon` changes.
 */
export function HeaderIconButton({
  icon,
  label,
  onPress,
  bare = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Just the icon, no circle: Back buttons and Home's header. */
  bare?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      scaleTo={0.97}
      onPress={() => {
        tap();
        onPress();
      }}
      hitSlop={bare ? 10 : 6}
      style={!bare && styles.headerButton}
    >
      {bare ? (
        <IconSwap name={icon} size={icon === 'chevronLeft' ? 21 : 23} color={c.textSecondary} />
      ) : (
        <IconSwap name={icon} size={icon === 'chevronLeft' ? 16 : 18} color={c.text} />
      )}
    </PressableScale>
  );
}

const BALANCE_AMOUNT = { alignSelf: 'flex-start' } as const;

/**
 * The big total balance, dimmed cents and all. Tapping it hides or shows balances
 * everywhere (as in most wallets), so no extra button crowds the number.
 */
export function BalanceAmount({
  style,
  fractionStyle,
}: {
  style: StyleProp<TextStyle>;
  fractionStyle: StyleProp<TextStyle>;
}) {
  const { hideBalance } = useSettings();
  const { usd } = useWalletView();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={hideBalance ? 'Balance hidden' : `Balance ${formatUsd(usd)}`}
      accessibilityHint={hideBalance ? 'Shows your balance' : 'Hides your balance'}
      scaleTo={0.97}
      onPress={() => {
        tap();
        toggleHideBalance();
      }}
      style={BALANCE_AMOUNT}
    >
      <NumberPopIn
        value={hideBalance ? HIDDEN_AMOUNT : formatUsd(usd)}
        style={style}
        fractionStyle={fractionStyle}
      />
    </PressableScale>
  );
}

/** Height of a pushed screen's header row (back, title, buttons). */
const HEADER_HEIGHT = 52;

/** Scroll distance over which the header's hairline fades in. */
const RULE_FADE = 8;

/**
 * The frame for full-screen pushed pages: status-bar inset, `ScreenHeader`,
 * scrolling content, an optional footer pinned to the bottom, and the bottom safe
 * area. `overlay` renders above the content but under the footer (e.g. a menu that
 * opens from a footer button).
 */
export function PushedScreen({
  title,
  fallback,
  right,
  footer,
  overlay,
  scroll = true,
  contentStyle,
  children,
}: {
  title: ReactNode;
  fallback?: Href;
  right?: ReactNode;
  footer?: ReactNode;
  overlay?: ReactNode;
  /** Set false for screens that lay out their own content (e.g. a fixed panel). */
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  // Above a footer, its own padding already separates them; elsewhere clear the home indicator.
  const bottom = footer ? SCREEN.footerTop : insets.bottom + SCREEN.bottom;
  // A hairline under the header fades in once the content scrolls beneath it.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const rule = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, RULE_FADE], [0, 1], Extrapolation.CLAMP),
  }));
  return (
    // Section headers marked `Sticky` pin just under the header as they scroll up.
    <StickyArea
      scrollY={scrollY}
      top={insets.top + HEADER_HEIGHT}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <ScreenHeader title={title} fallback={fallback} right={right} />
      <Animated.View pointerEvents="none" style={[styles.headerRule, rule]} />
      {scroll ? (
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Only scroll (and bounce) when there's more than fits; a page that fits
          // stays put, so dragging a chart on it scrubs instead of moving the page.
          alwaysBounceVertical={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[{ paddingBottom: bottom }, contentStyle]}
        >
          {children}
        </Animated.ScrollView>
      ) : (
        <View style={[styles.flex, contentStyle]}>{children}</View>
      )}
      {overlay}
      {footer && (
        <View style={[styles.screenFooter, { paddingBottom: insets.bottom + SCREEN.footerBottom }]}>
          {footer}
        </View>
      )}
    </StickyArea>
  );
}

/**
 * Centred icon, title and hint for a screen or section with nothing to show yet. Give it
 * an `action` when there's an obvious next step (Receive, Add money, Clear filters).
 * `compact` trims the padding for use inside a card or under a section label.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact,
}: {
  icon: IconName;
  title: string;
  hint: string;
  action?: { label: string; onPress: () => void };
  compact?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={26} color={c.accentText} />
      </View>
      <TextsReveal
        id={title}
        align="center"
        first={<Text style={styles.emptyTitle}>{title}</Text>}
        second={<Text style={styles.emptyHint}>{hint}</Text>}
      />
      {action && (
        <PressableScale
          accessibilityRole="button"
          onPress={() => {
            tap();
            action.onPress();
          }}
          scaleTo={0.97}
          style={styles.emptyAction}
        >
          <Text style={styles.emptyActionLabel}>{action.label}</Text>
        </PressableScale>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    // Bleed past the screen gutter so the press highlight runs edge to edge.
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  rowTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  rowSubtitle: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  rowEnd: {
    alignItems: 'flex-end',
    gap: 2,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  rule: {
    flex: 1,
    height: 1,
    backgroundColor: c.divider,
  },
  dividerLabel: {
    marginLeft: 6,
    color: c.textSecondary,
    fontSize: 14,
  },
  screen: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  screenFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: SCREEN.footerTop,
    paddingHorizontal: SCREEN.gutter,
    backgroundColor: c.canvas,
  },
  headerRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  // Equal flexible sides keep the title centred whatever sits on the right.
  headerSide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerEnd: {
    justifyContent: 'flex-end',
    gap: 8,
  },
  headerButton: {
    width: HEADER_BUTTON,
    height: HEADER_BUTTON,
    borderRadius: HEADER_BUTTON / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  headerTitle: {
    textAlign: 'center',
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 32,
  },
  emptyCompact: {
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  emptyTitle: {
    marginTop: 14,
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  emptyHint: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptyAction: {
    marginTop: 18,
    height: 40,
    paddingHorizontal: 20,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  emptyActionLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
}));
