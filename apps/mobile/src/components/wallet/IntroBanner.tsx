import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/**
 * The intro banner at the top of a Trade product (Perps, Predict): a graphic, a
 * one-line pitch and a link to the product's guide. Tapping it opens the guide;
 * ✕ dismisses it and it fades out.
 */
export function IntroBanner({
  graphic,
  title,
  body,
  link,
  onOpen,
  onDismiss,
}: {
  graphic: ReactNode;
  title: string;
  body: string;
  /** e.g. "How perps work". */
  link: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <Animated.View exiting={FadeOut.duration(DURATION.quick)} style={styles.banner}>
      <PressableScale
        accessibilityRole="button"
        accessibilityHint={`Opens a short guide: ${link}`}
        scaleTo={0.98}
        onPress={() => {
          tap();
          onOpen();
        }}
        style={styles.open}
      >
        <View style={styles.graphic}>{graphic}</View>
        <View style={styles.flex}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
          <Text style={styles.link}>{link} ›</Text>
        </View>
      </PressableScale>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={10}
        scaleTo={0.88}
        onPress={() => {
          tap();
          onDismiss();
        }}
      >
        <Icon name="close" size={16} color={c.textSecondary} />
      </PressableScale>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  banner: {
    // Even 16pt above; the content below sets its own 16pt gap.
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    // More room right of the close button, so it doesn't hug the edge.
    paddingRight: 20,
    borderRadius: 18,
    backgroundColor: c.card,
  },
  open: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  graphic: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  title: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  body: {
    marginTop: 3,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  link: {
    marginTop: 6,
    color: c.accentText,
    fontSize: 14,
    fontWeight: '500',
  },
}));
