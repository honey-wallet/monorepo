import { usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Entrance, Rise } from '@/components/motion/Rise';
import { StickyArea } from '@/components/motion/Sticky';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { useTabReselect } from '@/lib/tab-reselect';
import { makeStyles } from '@/theme';

/** Gap between the top bar and the content. */
const BAR_GAP = 8;
/** First-frame guess at the bar's height (title row ~44pt), until it's measured. */
const BAR_GUESS = 12 + 44 + BAR_GAP;

/**
 * Scrolling tab screen with an optional title bar (`leading` before the title, e.g. a
 * back button, and `right` beside it, e.g. HeaderActions), padded clear of the
 * floating tab bar. Content can grow to fill the screen (e.g. to pin a button low).
 * The first visit each session, the bar then the content rise in. The bar stays put
 * at the top, flat on the page colour with no hairline, like Search's pinned search
 * row, so every tab's top bar looks and behaves the same; content scrolls under it.
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
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // Tapping this tab again while it's open scrolls back to the top.
  const tab = usePathname().split('/').filter(Boolean).pop();
  useTabReselect(tab, () => scrollRef.current?.scrollTo({ y: 0, animated: true }));
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const [barHeight, setBarHeight] = useState(insets.top + BAR_GUESS);
  return (
    <Entrance id={`tab:${title ?? 'untitled'}`}>
      {/* `Sticky` content (search, tabs, section headers) pins under the status bar, or under the title bar. */}
      <StickyArea scrollY={scrollY} top={title ? barHeight : insets.top} style={styles.root}>
        {title ? (
          <View
            style={[styles.bar, { paddingTop: insets.top + 12 }]}
            onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
          >
            <Rise style={styles.titleRow}>
              <View style={styles.titleLead}>
                {leading}
                <Text style={styles.title} accessibilityRole="header">
                  {title}
                </Text>
              </View>
              {right}
            </Rise>
          </View>
        ) : null}
        <Animated.ScrollView
          ref={scrollRef}
          style={styles.root}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: title ? BAR_GAP : insets.top + 12,
            flexGrow: 1,
            paddingBottom: insets.bottom + (tabBar ? TAB_BAR_HEIGHT + 24 : 8),
            paddingHorizontal: 18,
          }}
        >
          <StatusBar style="auto" />
          <Rise index={1} style={styles.content}>
            {children}
          </Rise>
        </Animated.ScrollView>
        {/* Keeps scrolled content from running under the status bar. */}
        {title ? null : <View style={[styles.statusCover, { height: insets.top }]} />}
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
  // The fixed top bar: page colour, no hairline, like Search's pinned row.
  bar: {
    paddingHorizontal: 18,
    paddingBottom: BAR_GAP,
    backgroundColor: c.canvas,
  },
  statusCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: c.canvas,
  },
  titleRow: {
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
