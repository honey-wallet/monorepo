import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Entrance, Rise } from '@/components/motion/Rise';
import { StickyArea } from '@/components/motion/Sticky';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { makeStyles } from '@/theme';

/** Scroll distance over which the large title hands over to the small one. */
const COMPACT_FROM = 24;
const COMPACT_TO = 52;
const COMPACT_BAR = 40;

/**
 * Scrolling tab screen with an optional large title (`leading` before it, e.g. a
 * back button, and `right` beside it, e.g. HeaderActions), padded clear of the
 * floating tab bar. Content can grow to fill the screen (e.g. to pin a button low).
 * The first visit each session, the title then the content rise in; once the large
 * title scrolls away, a small centred one settles in at the top, as in iOS.
 */
export function TabScreen({
  title,
  leading,
  right,
  tabBar = true,
  children,
}: {
  title?: string;
  leading?: ReactNode;
  right?: ReactNode;
  /** False on screens that hide the tab bar (Trade), so the bottom isn't padded for it. */
  tabBar?: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const compact = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [COMPACT_FROM, COMPACT_TO], [0, 1], Extrapolation.CLAMP),
  }));
  const compactTitle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          scrollY.value,
          [COMPACT_FROM, COMPACT_TO],
          [-4, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  return (
    <Entrance id={`tab:${title ?? 'untitled'}`}>
      {/* `Sticky` content (search, tabs, section headers) pins under the status bar, or under the small title once it shows. */}
      <StickyArea
        scrollY={scrollY}
        top={insets.top + (title ? COMPACT_BAR : 0)}
        style={styles.root}
      >
        <Animated.ScrollView
          style={styles.root}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: insets.top + 12,
            flexGrow: 1,
            paddingBottom: insets.bottom + (tabBar ? TAB_BAR_HEIGHT + 24 : 8),
            paddingHorizontal: 18,
          }}
        >
          <StatusBar style="auto" />
          {title ? (
            <Rise style={styles.titleRow}>
              <View style={styles.titleLead}>
                {leading}
                <Text style={styles.title} accessibilityRole="header">
                  {title}
                </Text>
              </View>
              {right}
            </Rise>
          ) : null}
          <Rise index={1} style={styles.content}>
            {children}
          </Rise>
        </Animated.ScrollView>
        {/* Keeps scrolled content from running under the status bar. */}
        <View style={[styles.statusCover, { height: insets.top }]} />
        {title ? (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.compact,
              { paddingTop: insets.top, height: insets.top + COMPACT_BAR },
              compact,
            ]}
          >
            <Animated.Text style={[styles.compactTitle, compactTitle]}>{title}</Animated.Text>
          </Animated.View>
        ) : null}
      </StickyArea>
    </Entrance>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  // Lets content grow to fill the screen, as it could before it was wrapped.
  content: {
    flexGrow: 1,
  },
  compact: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.canvas,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  compactTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  statusCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: c.canvas,
  },
  titleRow: {
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleLead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    color: c.text,
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
}));
