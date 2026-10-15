// Motion: transitions.dev "Menu dropdown" (https://transitions.dev), ported to
// Reanimated. The menu grows from the trigger's corner (0.97 → 1, 250ms) and closes
// faster (→ 0.99, 150ms), both on the smooth ease-out curve.
import { type ReactNode, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  type StyleProp,
  Text,
  useWindowDimensions,
  type View,
  type ViewStyle,
} from 'react-native';
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
import { AccordionChevron } from './Accordion';
import { PressableRow } from './PressableRow';
import { PressableScale } from './PressableScale';

const PRE_SCALE = 0.97;
const CLOSING_SCALE = 0.99;

export type MenuOption<T extends string> = {
  value: T;
  label: string;
  /** A symbol icon, or any element (e.g. a token logo) via `leading`. */
  icon?: IconName;
  leading?: ReactNode;
};

type Props<T extends string> = {
  options: MenuOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Short label for the trigger pill; defaults to the selected option's label. */
  triggerLabel?: string;
  /** Custom trigger content and style, replacing the default grey pill. */
  trigger?: (open: boolean) => ReactNode;
  triggerStyle?: StyleProp<ViewStyle>;
};

/** A pill that opens a menu of options under it, with a check on the selected one. */
export function MenuDropdown<T extends string>({
  options,
  value,
  onChange,
  triggerLabel,
  trigger: renderTrigger,
  triggerStyle,
}: Props<T>) {
  const styles = useStyles();
  const c = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const trigger = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [open, setOpen] = useState(false);
  const progress = useSharedValue(0);
  const closing = useSharedValue(false);

  const show = () => {
    tap();
    trigger.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ top: y + h + 8, right: screenWidth - (x + w) });
      setOpen(true);
      closing.value = false;
      progress.value = 0;
      progress.value = withTiming(1, {
        duration: reduceMotion ? 0 : DURATION.fast,
        easing: EASE.smoothOut,
      });
    });
  };

  const hide = () => {
    closing.value = true;
    progress.value = withTiming(0, {
      duration: reduceMotion ? 0 : DURATION.quick,
      easing: EASE.smoothOut,
    });
    setTimeout(() => setOpen(false), reduceMotion ? 0 : DURATION.quick);
  };

  const menuStyle = useAnimatedStyle(() => {
    const from = closing.value ? CLOSING_SCALE : PRE_SCALE;
    return {
      opacity: progress.value,
      transform: [{ scale: from + (1 - from) * progress.value }],
    };
  });

  const selected = options.find((o) => o.value === value);

  return (
    <>
      <PressableScale
        ref={trigger}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={show}
        style={triggerStyle ?? styles.trigger}
      >
        {renderTrigger ? (
          renderTrigger(open)
        ) : (
          <>
            <Text style={styles.triggerLabel}>{triggerLabel ?? selected?.label}</Text>
            <AccordionChevron open={open} size={12} color={c.text} />
          </>
        )}
      </PressableScale>

      <Modal transparent visible={open} animationType="none" onRequestClose={hide}>
        <Pressable style={styles.backdrop} onPress={hide} accessibilityLabel="Close menu" />
        {anchor && (
          <Animated.View style={[styles.menu, { top: anchor.top, right: anchor.right }, menuStyle]}>
            {options.map((option) => (
              <PressableRow
                key={option.value}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: option.value === value }}
                onPress={() => {
                  tap();
                  onChange(option.value);
                  hide();
                }}
                style={styles.item}
              >
                {option.leading ??
                  (option.icon && <Icon name={option.icon} size={16} color={c.textSecondary} />)}
                <Text style={styles.itemLabel}>{option.label}</Text>
                {option.value === value && <Icon name="checkCircle" size={16} color={c.text} />}
              </PressableRow>
            ))}
          </Animated.View>
        )}
      </Modal>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: c.raised,
  },
  triggerLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  menu: {
    position: 'absolute',
    minWidth: 250,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.divider,
    transformOrigin: 'right top',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 46,
    paddingHorizontal: 16,
  },
  itemLabel: {
    flex: 1,
    color: c.text,
    fontSize: 16,
  },
}));
