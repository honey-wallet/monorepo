import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { makeStyles } from '@/theme';

/**
 * Scrolling tab screen with an optional large title (`leading` before it, e.g. a
 * back button, and `right` beside it, e.g. HeaderActions), padded clear of the
 * floating tab bar. Content can grow to fill the screen (e.g. to pin a button low).
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
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.root}
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
          <View style={styles.titleRow}>
            <View style={styles.titleLead}>
              {leading}
              <Text style={styles.title} accessibilityRole="header">
                {title}
              </Text>
            </View>
            {right}
          </View>
        ) : null}
        {children}
      </ScrollView>
      {/* Keeps scrolled content from running under the status bar. */}
      <View style={[styles.statusCover, { height: insets.top }]} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
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
