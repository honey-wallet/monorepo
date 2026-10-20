// Home's NFTs tab. The grid's tiles rise in on a short stagger the first time the tab
// opens this session (scale 0.96 → 1 with a fade, 30ms apart, strong ease-out), then
// show still. Tapping a tile is the course's App Store card → detail: the art lifts
// out of its tile and grows into place (a critically damped spring, so it can be
// interrupted), the page fades in behind it and the details follow a beat later.
// Closing reverses the art into its tile on a shorter ease-out while the details leave
// almost at once (exits are quicker). Drag down anywhere off the art to dismiss: the
// view follows the finger 1:1, shrinking a little, and springs back if let go early.
// The art itself tilts toward a pressing finger (TiltCard); the details, traits
// included, arrive as one block. Under Reduce Motion the detail only fades.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type View as ViewType,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { NftArt } from '@/components/home/NftArt';
import { Icon, type IconName } from '@/components/Icon';
import { LikeButton } from '@/components/motion/LikeButton';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { TiltCard } from '@/components/motion/TiltCard';
import { StatRow } from '@/components/sheets/Sheet';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { NFTS, type Nft, nftFloorUsd, nftNative } from '@/lib/collectibles';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { chainSymbol, formatUsd } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, squircle, useTheme } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

const COLUMNS = 3;
const GAP = 10;
const TILE_RADIUS = 14;
const DETAIL_RADIUS = 24;
/** Drag this far down (or flick) to close the detail. */
const DISMISS_AT = 110;
const FLICK = 900;

type Rect = { x: number; y: number; w: number; h: number };

/** Tiles play their entrance once per session, like the screen's own. */
let gridPlayed = false;

const formatFloor = (nft: Nft) =>
  `${nft.floor < 0.1 ? nft.floor.toFixed(3) : nft.floor >= 10 ? nft.floor.toFixed(0) : nft.floor.toFixed(2)} ${nftNative(nft)}`;

export function NftGallery() {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<{ nft: Nft; from: Rect } | null>(null);
  const [play] = useState(() => !gridPlayed);
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const loading = useFirstLoad(LOADS.nfts);
  useEffect(() => {
    gridPlayed = true;
  }, []);

  const tile = width ? (width - GAP * (COLUMNS - 1)) / COLUMNS : 0;

  if (!loading && NFTS.length === 0) {
    return (
      <EmptyState
        compact
        icon="image"
        title="No NFTs yet"
        hint="Collectibles you own will show up here."
        action={{ label: 'Receive', onPress: () => router.push('/receive') }}
      />
    );
  }

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <SkeletonReveal
        loading={loading}
        skeleton={
          <View style={styles.grid}>
            {tile
              ? Array.from({ length: COLUMNS * 2 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                  <View key={i} style={{ width: tile }}>
                    <SkeletonBar width={tile} height={tile} radius={TILE_RADIUS} />
                    <View style={styles.nameSkeleton}>
                      <SkeletonBar width="70%" height={10} radius={5} />
                    </View>
                  </View>
                ))
              : null}
          </View>
        }
      >
        <View style={styles.grid}>
          {tile
            ? NFTS.map((nft, i) => (
                <Tile
                  key={nft.id}
                  nft={nft}
                  size={tile}
                  index={i}
                  play={play}
                  lifted={open?.nft.id === nft.id}
                  onOpen={(from) => {
                    tap();
                    setOpen({ nft, from });
                  }}
                />
              ))
            : null}
        </View>
      </SkeletonReveal>
      {open ? (
        <NftDetail
          nft={open.nft}
          from={open.from}
          liked={!!liked[open.nft.id]}
          onLike={() => setLiked((l) => ({ ...l, [open.nft.id]: !l[open.nft.id] }))}
          onClosed={() => setOpen(null)}
        />
      ) : null}
    </View>
  );
}

function Tile({
  nft,
  size,
  index,
  play,
  lifted,
  onOpen,
}: {
  nft: Nft;
  size: number;
  index: number;
  play: boolean;
  lifted: boolean;
  onOpen: (from: Rect) => void;
}) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const ref = useRef<ViewType>(null);
  const shown = useSharedValue(play ? 0 : 1);
  useEffect(() => {
    if (!play) return;
    const fade = withTiming(1, {
      duration: DURATION.medium,
      easing: EASE.smoothOut,
      reduceMotion: ReduceMotion.Never,
    });
    shown.value = reduceMotion ? fade : withDelay(Math.min(index, 3) * 30, fade);
  }, [play, index, shown, reduceMotion]);
  const still = reduceMotion;
  const enter = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: still ? 1 : 0.96 + 0.04 * shown.value }],
  }));

  return (
    <Animated.View ref={ref} collapsable={false} style={[{ width: size }, enter]}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={nft.name}
        scaleTo={0.97}
        // Measured on the outer view, which the press doesn't scale, so the art flies
        // back to exactly where it sits.
        onPress={() => ref.current?.measureInWindow((x, y) => onOpen({ x, y, w: size, h: size }))}
      >
        {/* While its detail is open the art has lifted out, so the tile shows a hole. */}
        <View style={[styles.art, { width: size, height: size }, lifted && styles.lifted]}>
          {lifted ? null : <NftArt nft={nft} size={size} />}
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {nft.name}
        </Text>
      </PressableScale>
    </Animated.View>
  );
}

function NftDetail({
  nft,
  from,
  liked,
  onLike,
  onClosed,
}: {
  nft: Nft;
  from: Rect;
  liked: boolean;
  onLike: () => void;
  onClosed: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const details = useSharedValue(0);
  const drag = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const closing = useSharedValue(false);
  const scrollY = useSharedValue(0);
  const ownsDrag = useSharedValue(false);
  const nativeScroll = Gesture.Native();
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  // Where the art lands, and how to get there from the tile (centre offset and scale).
  // Smaller on short screens, so the details and actions still fit below it.
  const side = Math.min(width - 40, height * 0.42);
  const to = { x: (width - side) / 2, y: insets.top + 52, w: side };
  const dx = from.x + from.w / 2 - (to.x + to.w / 2);
  const dy = from.y + from.h / 2 - (to.y + to.w / 2);
  const s = from.w / to.w;

  useEffect(() => {
    progress.value = reduceMotion
      ? withTiming(1, {
          duration: DURATION.fast,
          easing: EASE.ease,
          reduceMotion: ReduceMotion.Never,
        })
      : withSpring(1, SPRING.ui);
    const fade = withTiming(1, {
      duration: DURATION.fast,
      easing: EASE.smoothOut,
      reduceMotion: ReduceMotion.Never,
    });
    details.value = reduceMotion ? fade : withDelay(80, fade);
  }, [progress, details, reduceMotion]);

  const close = () => {
    if (closing.value) return;
    closing.value = true;
    const out = {
      duration: DURATION.fast,
      easing: EASE.smoothOut,
      reduceMotion: ReduceMotion.Never,
    };
    details.value = withTiming(0, { duration: DURATION.micro, easing: EASE.ease });
    if (!reduceMotion) drag.value = withTiming(0, out);
    progress.value = withTiming(0, out, (done) => {
      if (done) scheduleOnRN(onClosed);
    });
  };

  const pan = Gesture.Pan()
    .simultaneousWithExternalGesture(nativeScroll)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .failOffsetX([-24, 24])
    .onBegin(() => {
      ownsDrag.value = scrollY.value <= 0;
    })
    .onStart(() => {
      if (closing.value || !ownsDrag.value) return;
      cancelAnimation(drag);
      dragStart.value = drag.value;
    })
    .onUpdate((e) => {
      if (closing.value || !ownsDrag.value) return;
      // Follows the finger down; resists being pulled up.
      const next = dragStart.value + e.translationY;
      drag.value = next > 0 ? next : next * 0.2;
    })
    .onEnd((e) => {
      if (closing.value || !ownsDrag.value) return;
      if (drag.value > DISMISS_AT || e.velocityY > FLICK) scheduleOnRN(close);
      else
        drag.value = reduceMotion ? 0 : withSpring(0, { ...SPRING.release, velocity: e.velocityY });
    })
    .onFinalize((_e, finished) => {
      if (!finished && !closing.value && ownsDrag.value)
        drag.value = reduceMotion ? 0 : withSpring(0, SPRING.release);
      ownsDrag.value = false;
    });

  const still = reduceMotion;
  const backdrop = useAnimatedStyle(() => ({
    opacity: progress.value * interpolate(drag.value, [0, 400], [1, 0.4], Extrapolation.CLAMP),
  }));
  const art = useAnimatedStyle(() => {
    const p = progress.value;
    const shrink = interpolate(drag.value, [0, 400], [1, 0.82], Extrapolation.CLAMP);
    if (still) return { opacity: p, transform: [{ translateY: drag.value }] };
    const scale = (s + (1 - s) * p) * shrink;
    return {
      borderRadius: TILE_RADIUS / s + (DETAIL_RADIUS - TILE_RADIUS / s) * p,
      ...squircle,
      transform: [
        { translateX: dx * (1 - p) },
        { translateY: dy * (1 - p) + drag.value },
        { scale },
      ],
    };
  });
  const info = useAnimatedStyle(() => ({
    opacity: details.value,
    transform: [{ translateY: (still ? 0 : (1 - details.value) * 12) + drag.value * 0.9 }],
  }));

  const usd = formatUsd(nftFloorUsd(nft));

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={close}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <GestureDetector gesture={pan}>
          <View style={StyleSheet.absoluteFill}>
            <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdrop]} />

            <Animated.View
              style={[styles.detailArt, { left: to.x, top: to.y, width: to.w, height: to.w }, art]}
            >
              <TiltCard radius={DETAIL_RADIUS}>
                <NftArt nft={nft} size={to.w} />
              </TiltCard>
            </Animated.View>

            {/* A pushed page's header: back, the collection, and the heart */}
            <Animated.View style={[styles.header, { top: insets.top }, info]}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={12}
                onPress={() => {
                  tap();
                  close();
                }}
                style={styles.headerButton}
              >
                <Icon name="chevronLeft" size={18} color={c.text} />
              </PressableScale>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {nft.collection}
              </Text>
              <View style={styles.headerButton}>
                <LikeButton liked={liked} onToggle={onLike} size={22} />
              </View>
            </Animated.View>

            <Animated.View
              style={[styles.info, { top: to.y + to.w + 16, bottom: insets.bottom + 72 }, info]}
            >
              <GestureDetector gesture={nativeScroll}>
                <Animated.ScrollView
                  onScroll={onScroll}
                  scrollEventThrottle={16}
                  bounces={false}
                  style={styles.flex}
                >
                  <Text style={styles.detailName}>{nft.name}</Text>

                  <View style={styles.group}>
                    <StatRow
                      label="Floor"
                      value={
                        <Text style={styles.rowValue}>
                          {formatFloor(nft)} <Text style={styles.rowMuted}>· {usd}</Text>
                        </Text>
                      }
                    />
                    <StatRow
                      label="Chain"
                      value={
                        <View style={styles.inline}>
                          <TokenIcon symbol={chainSymbol(nft.chain)} size={16} />
                          <Text style={styles.rowValue}>{nft.chain}</Text>
                        </View>
                      }
                    />
                  </View>

                  <Text style={styles.groupTitle}>Traits</Text>
                  <View style={styles.group}>
                    {nft.traits.map((t) => (
                      <StatRow
                        key={t.type}
                        label={t.type}
                        value={
                          <Text style={styles.rowValue}>
                            {t.value} <Text style={styles.rowMuted}>· {t.rarity}%</Text>
                          </Text>
                        }
                      />
                    ))}
                  </View>
                </Animated.ScrollView>
              </GestureDetector>
            </Animated.View>

            {/* One primary and one secondary, like ActionFooter (Buy honey, Sell grey) */}
            <Animated.View style={[styles.actions, { bottom: insets.bottom + 12 }, info]}>
              <Action icon="send" label="Send" primary onPress={() => showToast('Coming soon')} />
              <Action
                icon="link"
                label="Share"
                onPress={() => Share.share({ message: `${nft.name} · ${nft.collection}` })}
              />
            </Animated.View>
          </View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function Action({
  icon,
  label,
  primary,
  onPress,
}: {
  icon: IconName;
  label: string;
  primary?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const color = primary ? c.onPrimary : c.text;
  return (
    <PressableScale
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.action, { backgroundColor: primary ? c.primary : c.raised }]}
    >
      <Icon name={icon} size={15} color={color} />
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  grid: {
    paddingTop: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
  },
  art: {
    ...radius(TILE_RADIUS),
    overflow: 'hidden',
    backgroundColor: c.card,
  },
  lifted: {
    backgroundColor: c.card,
  },
  // Same footprint as the name line under a tile (13pt text and its margins).
  nameSkeleton: {
    marginTop: 9,
    marginBottom: 11,
  },
  name: {
    marginTop: 6,
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 13,
  },
  backdrop: {
    backgroundColor: c.canvas,
  },
  detailArt: {
    position: 'absolute',
    overflow: 'hidden',
  },
  info: {
    position: 'absolute',
    left: 20,
    right: 20,
  },
  detailName: {
    marginBottom: 12,
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
  },
  actions: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    gap: 10,
  },
  header: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  group: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    ...radius(16),
    backgroundColor: c.card,
  },
  groupTitle: {
    marginTop: 14,
    marginBottom: 8,
    marginLeft: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowValue: {
    color: c.text,
    fontSize: 16,
  },
  rowMuted: {
    color: c.textSecondary,
  },
  action: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
}));
