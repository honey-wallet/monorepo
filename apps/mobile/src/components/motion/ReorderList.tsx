// Drag to reorder: hold a row's ⠿ handle and drag. While the finger is down the row
// IS the finger (1:1, no easing), with rubber-band resistance past either end. It
// lifts slightly (scale 1.02); the others move out of its way on a critically damped
// spring, so a row passed back and forth never jumps. On release it springs into its
// slot carrying the finger's velocity, with the small overshoot a drag earns. Each
// change of slot ticks a haptic. Under Reduce Motion there is no lift or overshoot.
// Lists can run sideways too (`axis="x"`, e.g. favourite cards in a scrolling row);
// there the whole item is the handle, picked up with a short hold so a plain swipe
// still scrolls the row.
import { type ReactNode, useEffect } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { grab, tap } from '@/lib/haptics';
import { makeStyles } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

/** How far past an end the row follows the finger: a fifth, like iOS rubber-banding. */
const ELASTIC = 0.2;

/** Hold this long before a sideways item lifts, so a quick swipe scrolls instead. */
const HOLD_MS = 220;

type Props<T extends string> = {
  items: readonly T[];
  /** Every row is this tall (this wide when sideways), so slots can be computed while dragging. */
  rowHeight: number;
  onReorder: (items: T[]) => void;
  /** Renders a row; place `handle` where the drag handle should go (null when sideways). */
  renderRow: (item: T, handle: ReactNode) => ReactNode;
  /** `x` lays the items out in a row and drags them sideways. */
  axis?: 'x' | 'y';
  /** Space between items. */
  gap?: number;
  /** Sideways only: the row's height. */
  crossSize?: number;
  /** Told when a drag starts and ends, e.g. to stop a parent scroll view meanwhile. */
  onDragChange?: (dragging: boolean) => void;
};

/** A short list whose rows can be dragged into a new order by their handle. */
export function ReorderList<T extends string>({
  items,
  rowHeight,
  onReorder,
  renderRow,
  axis = 'y',
  gap = 0,
  crossSize,
  onDragChange,
}: Props<T>) {
  // Slot of each item, keyed by item; shared so every row can react while one drags.
  const slots = useSharedValue<Record<string, number>>(toSlots(items));
  useEffect(() => {
    slots.value = toSlots(items);
  }, [items, slots]);

  const commit = (next: Record<string, number>) => {
    onReorder([...items].sort((a, b) => next[a] - next[b]));
  };

  const length = items.length * (rowHeight + gap) - gap;
  return (
    <View style={axis === 'x' ? { width: length, height: crossSize } : { height: length }}>
      {items.map((item) => (
        <Row
          key={item}
          item={item}
          count={items.length}
          rowHeight={rowHeight}
          step={rowHeight + gap}
          sideways={axis === 'x'}
          slots={slots}
          onCommit={commit}
          onDragChange={onDragChange}
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
  step,
  sideways,
  slots,
  onCommit,
  onDragChange,
  renderRow,
}: {
  item: T;
  count: number;
  rowHeight: number;
  /** Distance from one slot to the next (size plus gap). */
  step: number;
  sideways: boolean;
  slots: { value: Record<string, number> };
  onCommit: (slots: Record<string, number>) => void;
  onDragChange?: (dragging: boolean) => void;
  renderRow: Props<T>['renderRow'];
}) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  // Offset along the list's axis (down a column, or across a row).
  const top = useSharedValue(slots.value[item] * step);
  const lifted = useSharedValue(0);
  const dragging = useSharedValue(false);
  const start = useSharedValue(0);
  const beforeDrag = useSharedValue<Record<string, number>>({});

  // Slide into place whenever this row's slot changes (someone else dragged past it).
  useAnimatedReaction(
    () => slots.value[item],
    (slot, previous) => {
      if (slot !== previous && !dragging.value)
        top.value = reduceMotion ? slot * step : withSpring(slot * step, SPRING.ui);
    },
  );

  const pan = Gesture.Pan();
  // A handle drags at once; a whole sideways item waits for a short hold.
  const gesture = (sideways ? pan.activateAfterLongPress(HOLD_MS) : pan.minDistance(0))
    .onStart(() => {
      cancelAnimation(top);
      beforeDrag.value = { ...slots.value };
      dragging.value = true;
      start.value = top.value;
      if (!reduceMotion)
        lifted.value = withTiming(1, { duration: DURATION.quick, easing: EASE.smoothOut });
      scheduleOnRN(grab);
      if (onDragChange) scheduleOnRN(onDragChange, true);
    })
    .onUpdate((e) => {
      const max = (count - 1) * step;
      const raw = start.value + (sideways ? e.translationX : e.translationY);
      // Past either end the row moves a fraction of the finger's travel.
      top.value = raw < 0 ? raw * ELASTIC : raw > max ? max + (raw - max) * ELASTIC : raw;
      const to = Math.min(Math.max(Math.round(top.value / step), 0), count - 1);
      const from = slots.value[item];
      if (to === from) return;
      slots.value = moveTo(slots.value, item, to);
      scheduleOnRN(tap);
    })
    .onFinalize((e, finished) => {
      // A touch that never became a drag (a tap, or a swipe that scrolled) changes nothing.
      if (!dragging.value) return;
      if (!finished) slots.value = beforeDrag.value;
      dragging.value = false;
      const slot = slots.value[item] * step;
      top.value = reduceMotion
        ? slot
        : withSpring(slot, { ...SPRING.release, velocity: sideways ? e.velocityX : e.velocityY });
      lifted.value = withTiming(0, { duration: DURATION.quick, easing: EASE.smoothOut });
      if (finished) scheduleOnRN(onCommit, slots.value);
      if (onDragChange) scheduleOnRN(onDragChange, false);
    });

  // Position is a transform (composited), not `top`, so dragging never relayouts.
  const style = useAnimatedStyle(() => ({
    zIndex: dragging.value ? 10 : 0,
    transform: [
      sideways ? { translateX: top.value } : { translateY: top.value },
      { scale: 1 + lifted.value * (sideways ? 0.04 : 0.02) },
    ],
    shadowOpacity: lifted.value * 0.3,
  }));

  // Screen readers can't drag: swiping up or down on the handle moves the row.
  const nudge = (by: number) => {
    const from = slots.value[item];
    const to = Math.min(Math.max(from + by, 0), count - 1);
    if (to === from) return;
    tap();
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

  if (sideways) {
    // The whole item is the handle; a hold picks it up.
    return (
      <GestureDetector gesture={gesture}>
        <Animated.View
          accessible
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
          style={[styles.item, { width: rowHeight }, style]}
        >
          {renderRow(item, null)}
        </Animated.View>
      </GestureDetector>
    );
  }
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
    top: 0,
    left: 0,
    right: 0,
    justifyContent: 'center',
    backgroundColor: c.card,
    shadowColor: '#000',
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  item: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
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
