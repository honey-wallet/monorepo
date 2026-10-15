// Drag to reorder: hold a row's ⠿ handle and drag. The row lifts (scale 1.02, the
// fast clock), the others slide out of its way on the smooth ease-out curve, and it
// settles into its slot on release. Each change of slot ticks a haptic.
import { type ReactNode, useEffect } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { tap } from '@/lib/haptics';
import { makeStyles } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const SETTLE = { duration: DURATION.fast, easing: EASE.smoothOut };

type Props<T extends string> = {
  items: readonly T[];
  /** Every row is this tall, so slots can be computed while dragging. */
  rowHeight: number;
  onReorder: (items: T[]) => void;
  /** Renders a row; place `handle` where the drag handle should go. */
  renderRow: (item: T, handle: ReactNode) => ReactNode;
};

/** A short list whose rows can be dragged into a new order by their handle. */
export function ReorderList<T extends string>({
  items,
  rowHeight,
  onReorder,
  renderRow,
}: Props<T>) {
  // Slot of each item, keyed by item; shared so every row can react while one drags.
  const slots = useSharedValue<Record<string, number>>(toSlots(items));
  useEffect(() => {
    slots.value = toSlots(items);
  }, [items, slots]);

  const commit = (next: Record<string, number>) => {
    onReorder([...items].sort((a, b) => next[a] - next[b]));
  };

  return (
    <View style={{ height: items.length * rowHeight }}>
      {items.map((item) => (
        <Row
          key={item}
          item={item}
          count={items.length}
          rowHeight={rowHeight}
          slots={slots}
          onCommit={commit}
          renderRow={renderRow}
        />
      ))}
    </View>
  );
}

function toSlots(items: readonly string[]) {
  return Object.fromEntries(items.map((item, i) => [item, i]));
}

/** Moves `item` into slot `to`, swapping with whichever item held it. */
function moveTo(slots: Record<string, number>, item: string, to: number) {
  'worklet';
  const from = slots[item];
  const next = { ...slots };
  for (const key of Object.keys(next)) if (next[key] === to) next[key] = from;
  next[item] = to;
  return next;
}

function Row<T extends string>({
  item,
  count,
  rowHeight,
  slots,
  onCommit,
  renderRow,
}: {
  item: T;
  count: number;
  rowHeight: number;
  slots: { value: Record<string, number> };
  onCommit: (slots: Record<string, number>) => void;
  renderRow: Props<T>['renderRow'];
}) {
  const styles = useStyles();
  const top = useSharedValue(slots.value[item] * rowHeight);
  const lifted = useSharedValue(0);
  const dragging = useSharedValue(false);
  const start = useSharedValue(0);

  // Slide into place whenever this row's slot changes (someone else dragged past it).
  useAnimatedReaction(
    () => slots.value[item],
    (slot, previous) => {
      if (slot !== previous && !dragging.value) top.value = withTiming(slot * rowHeight, SETTLE);
    },
  );

  const gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      dragging.value = true;
      start.value = top.value;
      lifted.value = withTiming(1, { duration: DURATION.quick, easing: EASE.smoothOut });
      scheduleOnRN(tap);
    })
    .onUpdate((e) => {
      const max = (count - 1) * rowHeight;
      top.value = Math.min(Math.max(start.value + e.translationY, 0), max);
      const to = Math.round(top.value / rowHeight);
      const from = slots.value[item];
      if (to === from) return;
      slots.value = moveTo(slots.value, item, to);
      scheduleOnRN(tap);
    })
    .onFinalize(() => {
      dragging.value = false;
      top.value = withTiming(slots.value[item] * rowHeight, SETTLE);
      lifted.value = withTiming(0, SETTLE);
      scheduleOnRN(onCommit, slots.value);
    });

  const style = useAnimatedStyle(() => ({
    top: top.value,
    zIndex: dragging.value ? 10 : 0,
    transform: [{ scale: 1 + lifted.value * 0.02 }],
    shadowOpacity: lifted.value * 0.3,
  }));

  // Screen readers can't drag: swiping up or down on the handle moves the row.
  const nudge = (by: number) => {
    const from = slots.value[item];
    const to = Math.min(Math.max(from + by, 0), count - 1);
    if (to === from) return;
    slots.value = moveTo(slots.value, item, to);
    onCommit(slots.value);
  };

  const handle = (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${item}`}
        accessibilityValue={{ text: `Position ${slots.value[item] + 1} of ${count}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        hitSlop={10}
        style={styles.handle}
      >
        <DragDots />
      </View>
    </GestureDetector>
  );

  return (
    <Animated.View style={[styles.row, { height: rowHeight }, style]}>
      {renderRow(item, handle)}
    </Animated.View>
  );
}

/** The ⠿ grip: two columns of three dots. */
function DragDots() {
  const styles = useStyles();
  return (
    <View style={styles.dots}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={styles.dot} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    justifyContent: 'center',
    backgroundColor: c.card,
    shadowColor: '#000',
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  handle: {
    width: 28,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: {
    width: 11,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.textSecondary,
  },
}));
