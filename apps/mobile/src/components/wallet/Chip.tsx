import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles } from '@/theme';

type Props = {
  label: string;
  /** A token logo or icon before the label. */
  leading?: ReactNode;
  selected?: boolean;
  /** `outline` (bordered) or `filled` (grey); either way the selected chip turns honey. */
  variant?: 'outline' | 'filled';
  /** Without `onPress` the chip is a static label, e.g. a list of supported networks. */
  onPress?: () => void;
  /** `radio` for chips that pick one option from a set. */
  accessibilityRole?: 'button' | 'radio';
  accessibilityLabel?: string;
};

/** The one chip: a pill with an optional leading logo, used for filters and quick picks. */
export function Chip({
  label,
  leading,
  selected = false,
  variant = 'outline',
  onPress,
  accessibilityRole = 'button',
  accessibilityLabel,
}: Props) {
  const styles = useStyles();
  const filled = variant === 'filled';
  const style = [
    styles.chip,
    leading ? styles.withLeading : null,
    filled ? styles.filled : styles.outline,
    selected && (filled ? styles.filledSelected : styles.outlineSelected),
  ];
  const content = (
    <>
      {leading}
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={style}>{content}</View>;
  return (
    <PressableScale
      accessibilityRole={accessibilityRole}
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      scaleTo={0.97}
      onPress={() => {
        tap();
        onPress();
      }}
      style={style}
    >
      {content}
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  chip: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: 19,
  },
  withLeading: {
    paddingLeft: 7,
  },
  outline: {
    borderWidth: 1,
    borderColor: c.divider,
  },
  // Honey, like the filled variant, so the choice reads clearly in light and dark.
  outlineSelected: {
    backgroundColor: c.accentSurface,
    borderColor: c.accentSurface,
  },
  filled: {
    backgroundColor: c.raised,
  },
  filledSelected: {
    backgroundColor: c.accentSurface,
  },
  label: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  labelSelected: {
    color: c.accentText,
    fontWeight: '600',
  },
}));
