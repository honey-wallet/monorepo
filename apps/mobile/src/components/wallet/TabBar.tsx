// Switching tabs happens tens of times a day, so the motion stays quick: a lighter
// pill glides under the active tab in 200ms on ease-in-out (an on-screen move),
// starting from wherever it is so rapid taps never jump. It snaps into place on first
// paint and under Reduce Motion; icons crossfade between muted and active in 150ms.
import type { Tabs } from 'expo-router';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { isWeb } from '@/lib/platform';
import { reselectTab } from '@/lib/tab-reselect';
import { makeStyles, type Palette, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const PILL_TABS: { name: string; icon: IconName; label: string }[] = [
  { name: 'home', icon: 'home', label: 'Home' },
  // review: no Savings in the extension, like trading; the phone keeps it.
  // { name: 'savings', icon: 'piggyBank', label: 'Savings' },
  ...(isWeb ? [] : [{ name: 'savings', icon: 'piggyBank' as IconName, label: 'Savings' }]),
  // On the phone it's the browser (review), so a globe; the extension's tab is just search.
  // { name: 'search', icon: 'search', label: 'Search' },
  isWeb
    ? { name: 'search', icon: 'search', label: 'Search' }
    : { name: 'search', icon: 'globe', label: 'Browse' },
  { name: 'activity', icon: 'history', label: 'Activity' },
];

const PAD = 4;
const BORDER = 1;
const GAP = 3;
const SLIDE = { duration: DURATION.fast, easing: EASE.inOut };
const FADE = { duration: DURATION.quick, easing: EASE.ease };

/** How far above the bar the content fade starts. */
const FADE_EXTRA = 36;

/** Height the tab bar covers above the safe area; screens pad their content by this. */
export const TAB_BAR_HEIGHT = 58 + 16;

/** Floating segmented tabs plus a separate honey Trade button, after Uniswap. Hidden on Trade. */
export function TabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const current = state.routes[state.index]?.name;
  const index = PILL_TABS.findIndex((tab) => tab.name === current);

  const [tabWidth, setTabWidth] = useState(0);
  const offset = useSharedValue(0);
  const visible = useSharedValue(index >= 0 ? 1 : 0);
  const placed = useRef(false);

  useEffect(() => {
    if (!tabWidth) return;
    if (index >= 0) {
      const to = index * (tabWidth + GAP);
      // Snap on first paint; slide afterwards.
      offset.value = placed.current && !reduceMotion ? withTiming(to, SLIDE) : to;
      placed.current = true;
    }
    visible.value = withTiming(index >= 0 ? 1 : 0, FADE);
  }, [index, tabWidth, reduceMotion, offset, visible]);

  const pillStyle = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateX: offset.value }],
  }));

  const go = (name: string) => {
    if (current !== name) {
      tap();
      navigation.navigate(name);
    }
    // Already here: back to the top, like a normal iOS tab bar.
    else reselectTab(name);
  };

  // Sits a little above the home indicator / gesture bar rather than hugging the edge.
  const bottom = Math.max(insets.bottom, 12) + 8;
  const fadeHeight = bottom + TAB_BAR_HEIGHT + FADE_EXTRA;
  const solidFrom = (FADE_EXTRA + TAB_BAR_HEIGHT / 2) / fadeHeight;

  // Trade is a focused flow: no tab bar, a back button instead.
  if (current === 'trade') return null;

  return (
    <>
      {/* Page content fades out under the bar, so the bar reads as floating above it. */}
      <Svg
        pointerEvents="none"
        width="100%"
        height={fadeHeight}
        style={[styles.fade, { height: fadeHeight }]}
      >
        <Defs>
          <LinearGradient id="navFade" x1="0" y1="0" x2="0" y2="1">
            {/* Clear above the bar, solid from the bar's middle down to the screen edge. */}
            <Stop offset="0" stopColor={c.canvas} stopOpacity={0} />
            <Stop offset={solidFrom} stopColor={c.canvas} stopOpacity={1} />
            <Stop offset="1" stopColor={c.canvas} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={fadeHeight} fill="url(#navFade)" />
      </Svg>
      <View style={[styles.bar, { bottom }]}>
        <View
          style={styles.tabs}
          onLayout={(e) => {
            // The layout width includes the 1pt border on each side; the tabs (and the
            // pill, absolutely placed inside the border) only get what's within it.
            const inner =
              e.nativeEvent.layout.width - BORDER * 2 - PAD * 2 - GAP * (PILL_TABS.length - 1);
            setTabWidth(inner / PILL_TABS.length);
          }}
        >
          {tabWidth > 0 && <Animated.View style={[styles.pill, { width: tabWidth }, pillStyle]} />}
          {PILL_TABS.map((tab, i) => (
            <Pressable
              key={tab.name}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: i === index }}
              onPress={() => go(tab.name)}
              style={styles.tab}
            >
              <TabIcon icon={tab.icon} active={i === index} />
            </Pressable>
          ))}
        </View>
        {/* review: Swap is back in the extension, so the Trade button is too.
        {isWeb ? null : ( */}
        {
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Trade"
            onPress={() => go('trade')}
            scaleTo={0.97}
            style={styles.fab}
          >
            <Icon name="trade" size={30} color={c.onPrimary} />
          </PressableScale>
        }
      </View>
    </>
  );
}

/** Muted and active icons stacked, cross-fading on the same clock as the pill. */
function TabIcon({ icon, active }: { icon: IconName; active: boolean }) {
  const c = useTheme();
  const progress = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, FADE);
  }, [active, progress]);
  // The piggy bank drawing has more built-in padding than the SF Symbols.
  const iconSize = icon === 'piggyBank' ? 31 : 28;
  const activeStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const mutedStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  return (
    <View>
      <Animated.View style={mutedStyle}>
        <Icon name={icon} size={iconSize} color={c.textSecondary} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute' }, activeStyle]}>
        <Icon name={icon} size={iconSize} color={c.text} />
      </Animated.View>
    </View>
  );
}

/** Soft drop shadow that lifts the bar off the page. */
const lifted = (c: Palette) => ({
  shadowColor: '#000',
  shadowOpacity: c.navShadow,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  elevation: 10,
});

const useStyles = makeStyles((c) => ({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  bar: {
    position: 'absolute',
    left: 18,
    right: 18,
    flexDirection: 'row',
    gap: 12,
  },
  tabs: {
    flex: 1,
    height: 58,
    flexDirection: 'row',
    gap: GAP,
    padding: PAD,
    borderRadius: 29,
    borderWidth: BORDER,
    borderColor: c.navEdge,
    backgroundColor: c.navBar,
    ...lifted(c),
  },
  pill: {
    position: 'absolute',
    top: PAD,
    bottom: PAD,
    left: PAD,
    borderRadius: 25,
    backgroundColor: c.navPill,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    width: 72,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
    ...lifted(c),
  },
}));
