// Motion: clearing a search happens often, so it's quick: tapping ✕ sends the typed
// words down 6px and out (150ms, an exit, 20ms apart), while the placeholder settles
// in from 6px above (200ms, ease-out). Under Reduce Motion the field just clears.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type StyleProp, TextInput, View, type ViewStyle } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE, PRESS_SCALE } from '@/theme/motion';

const OUT_DUR = DURATION.quick;
const IN_DUR = DURATION.fast;
const FLY = DISTANCE.small;
const WORD_GAP = 20;

const wordOut = (index: number) =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: FLY }], easing: EASE.smoothOut },
  })
    .duration(OUT_DUR)
    .delay(index * WORD_GAP);

const placeholderIn = () =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: -FLY }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  }).duration(IN_DUR);

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Something at the right end, e.g. the token picker's network filter. */
  trailing?: ReactNode;
  autoFocus?: boolean;
  /** Called when the field is tapped, e.g. to open a picker instead of typing. */
  onFocus?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The one search field: a rounded pill with a magnifier, used by every search. Without
 * `trailing` it shows a ✕ while there's text, and clearing dissolves the words.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  trailing,
  autoFocus,
  onFocus,
  style,
}: Props) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  // The text being cleared, drawn over the empty field while it dissolves.
  const [ghost, setGhost] = useState<{ id: number; words: string[] } | null>(null);
  const done = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(done.current), []);

  const clear = () => {
    tap();
    onChangeText('');
    if (reduceMotion) return;
    const words = value.split(/(\s+)/).filter(Boolean);
    clearTimeout(done.current);
    setGhost({ id: Date.now(), words });
    done.current = setTimeout(() => setGhost(null), OUT_DUR + words.length * WORD_GAP);
  };

  return (
    <View style={[styles.field, style]}>
      <Icon name="search" size={18} color={c.textSecondary} />
      <View style={styles.inputArea}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          // While the old words dissolve, the placeholder falls in as its own layer.
          placeholder={ghost ? '' : placeholder}
          placeholderTextColor={c.placeholder}
          selectionColor={c.primary}
          autoFocus={autoFocus}
          onFocus={onFocus}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="never"
          accessibilityLabel={placeholder}
          style={styles.input}
        />
        {ghost && (
          <View key={ghost.id} pointerEvents="none" style={styles.overlay}>
            <Animated.Text entering={placeholderIn()} style={[styles.text, styles.placeholder]}>
              {placeholder}
            </Animated.Text>
            <View style={styles.words}>
              {ghost.words.map((word, i) => (
                <Animated.Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: words of one snapshot; position is identity.
                  key={i}
                  entering={wordOut(i)}
                  style={[styles.text, styles.ghostWord]}
                >
                  {word}
                </Animated.Text>
              ))}
            </View>
          </View>
        )}
      </View>
      {trailing ??
        (value ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={10}
            scaleTo={PRESS_SCALE}
            onPress={clear}
            style={styles.clear}
          >
            <Icon name="close" size={10} color={c.raised} />
          </PressableScale>
        ) : null)}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 16,
    paddingRight: 12,
    borderRadius: 24,
    backgroundColor: c.raised,
  },
  inputArea: {
    flex: 1,
    height: '100%',
    justifyContent: 'center',
  },
  input: {
    height: '100%',
    color: c.text,
    fontSize: 17,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  words: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  text: {
    fontSize: 17,
  },
  placeholder: {
    color: c.placeholder,
  },
  ghostWord: {
    color: c.text,
  },
  clear: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.placeholder,
  },
}));
