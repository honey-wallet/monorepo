// Tab switches happen tens of times a day, so the motion stays quick: the honey
// underline glides to the selected tab and resizes to it in 200ms on ease-in-out (an
// on-screen move). Each move starts from wherever the bar is, so rapid taps never
// jump; it snaps into place on first paint and under Reduce Motion.
import { useEffect, useRef, useState } from 'react';
import { type LayoutRectangle, Pressable, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const SLIDE = { duration: DURATION.fast, easing: EASE.inOut };

/** Above this many tabs the symbols are dropped, so every label still fits. */
const MAX_WITH_ICONS = 3;

type Props<T extends string> = {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** A symbol before each label, shown while there are few enough tabs to fit it. */
  icons?: Partial<Record<T, IconName>>;
};

/**
 * Text tabs sharing the row equally (½, ⅓, ¼…) over a hairline, with a honey
 * underline under the selected one. For switching between whole views, e.g. Trade's
 * products.
 */
export function UnderlineTabs<T extends string>({ options, value, onChange, icons }: Props<T>) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [layouts, setLayouts] = useState<Partial<Record<T, LayoutRectangle>>>({});
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const placed = useRef(false);
  const showIcons = icons && options.length <= MAX_WITH_ICONS;

  useEffect(() => {
    const layout = layouts[value];
    if (!layout) return;
    const animate = placed.current && !reduceMotion;
    x.value = animate ? withTiming(layout.x, SLIDE) : layout.x;
    width.value = animate ? withTiming(layout.width, SLIDE) : layout.width;
    placed.current = true;
  }, [value, layouts, reduceMotion, x, width]);

  const barStyle = useAnimatedStyle(() => ({
    width: width.value,
    transform: [{ translateX: x.value }],
  }));

  return (
    <View style={styles.row} accessibilityRole="tablist">
      {options.map((option) => {
        const active = option === value;
        const icon = showIcons ? icons[option] : undefined;
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onLayout={(e) => {
              const layout = e.nativeEvent.layout;
              setLayouts((prev) => ({ ...prev, [option]: layout }));
            }}
            onPress={() => {
              if (active) return;
              tap();
              onChange(option);
            }}
            style={styles.tab}
          >
            {icon && <Icon name={icon} size={18} color={active ? c.text : c.textSecondary} />}
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[styles.label, active && styles.labelActive]}
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
      <Animated.View style={[styles.bar, barStyle]} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  tab: {
    flex: 1,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  label: {
    color: c.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  },
  labelActive: {
    color: c.text,
  },
  // Sits on the hairline, covering it under the selected tab.
  bar: {
    position: 'absolute',
    left: 0,
    bottom: -1,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: c.primary,
  },
}));
