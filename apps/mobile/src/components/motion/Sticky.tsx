// Pinned headers for scroll screens whose top already has fixed chrome (a status-bar
// cover, a compact title or balance bar, a pushed screen's header). Native sticky
// headers pin to the very top of the scroll view, under that chrome, so instead each
// `Sticky` stays in the content and, once it scrolls up to `top`, a copy is shown
// pinned there. A later `Sticky` pushes the pinned one up and off as it arrives, like
// iOS section headers. The pinned copy follows the scroll directly (no easing), so it
// can never lag the finger.
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { makeStyles } from '@/theme';

type Spot = { id: string; y: number; x: number; w: number; h: number };

type Area = {
  rootRef: RefObject<View | null>;
  scrollY: SharedValue<number>;
  place: (spot: Spot) => void;
  remove: (id: string) => void;
  show: (id: string, content: ReactNode) => void;
};

const StickyContext = createContext<Area | null>(null);

/**
 * The screen's root, around its scroll view: pins `Sticky` content at `top` (points
 * from the root's top edge) as it scrolls there. `scrollY` is the scroll view's offset.
 */
export function StickyArea({
  scrollY,
  top,
  style,
  children,
}: {
  scrollY: SharedValue<number>;
  top: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const styles = useStyles();
  const rootRef = useRef<View>(null);
  const spots = useSharedValue<Spot[]>([]);
  const contents = useRef(new Map<string, ReactNode>());
  const [active, setActive] = useState<Spot | null>(null);
  const activeId = useRef<string | null>(null);
  const [, setVersion] = useState(0);

  const place = useCallback(
    (spot: Spot) => {
      const others = spots.value.filter((s) => s.id !== spot.id);
      spots.value = [...others, spot].sort((a, b) => a.y - b.y);
    },
    [spots],
  );
  const remove = useCallback(
    (id: string) => {
      spots.value = spots.value.filter((s) => s.id !== id);
      contents.current.delete(id);
    },
    [spots],
  );
  // Keep the pinned copy in step with the original (a typed search, a picked tab).
  const show = useCallback((id: string, content: ReactNode) => {
    contents.current.set(id, content);
    if (activeId.current === id) setVersion((v) => v + 1);
  }, []);

  const pin = (spot: Spot | null) => {
    activeId.current = spot?.id ?? null;
    setActive(spot);
  };

  // Which header is pinned: the last one that has reached `top`.
  useAnimatedReaction(
    () => {
      let found = -1;
      const list = spots.value;
      for (let i = 0; i < list.length; i++) {
        if (list[i].y - scrollY.value <= top) found = i;
      }
      return found;
    },
    (index, previous) => {
      if (index === previous) return;
      scheduleOnRN(pin, index >= 0 ? spots.value[index] : null);
    },
  );

  // The next header arriving pushes the pinned one up and out of the way.
  const pushed = useAnimatedStyle(() => {
    const list = spots.value;
    const id = active?.id;
    const i = list.findIndex((s) => s.id === id);
    const current = list[i];
    const next = list[i + 1];
    if (!current || !next) return { transform: [{ translateY: 0 }] };
    const gap = next.y - scrollY.value - (top + current.h);
    return { transform: [{ translateY: Math.min(0, gap) }] };
  });

  // One stable value, so re-rendering the area never makes its stickies re-register.
  const area = useMemo(
    () => ({ rootRef, scrollY, place, remove, show }),
    [scrollY, place, remove, show],
  );

  return (
    <StickyContext.Provider value={area}>
      <View ref={rootRef} style={[styles.root, style]}>
        {children}
        {active ? (
          <Animated.View
            style={[styles.pinned, { top, height: active.h }, pushed]}
            pointerEvents="box-none"
          >
            <View style={[styles.cover, { height: active.h }]} />
            <View style={{ marginLeft: active.x, width: active.w }}>
              {contents.current.get(active.id)}
            </View>
          </Animated.View>
        ) : null}
      </View>
    </StickyContext.Provider>
  );
}

/**
 * Content that pins under the screen's fixed chrome once scrolled up to it. Outside a
 * `StickyArea` it's plain content.
 */
export function Sticky({
  id,
  style,
  children,
}: {
  id: string;
  /** Spacing around it (margins), left out of the pinned copy. */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const area = useContext(StickyContext);
  const ref = useRef<View>(null);

  // Hand the latest content to the pinned copy on every render.
  useEffect(() => {
    area?.show(id, children);
  });
  useEffect(() => () => area?.remove(id), [area, id]);

  const measure = () => {
    const root = area?.rootRef.current;
    if (!area || !ref.current || !root) return;
    ref.current.measureLayout(root, (x, y, w, h) => {
      // Store where it sits in the content, independent of the current scroll.
      area.place({ id, x, y: y + area.scrollY.value, w, h });
    });
  };

  return (
    <View ref={ref} onLayout={measure} collapsable={false} style={style}>
      {children}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
  },
  pinned: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  // The page colour behind the pinned copy, edge to edge, so content scrolls under it.
  cover: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: c.canvas,
  },
}));
