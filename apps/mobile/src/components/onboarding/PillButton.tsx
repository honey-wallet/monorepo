import type { StyleProp, ViewStyle } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextMorph } from '@/components/motion/TextMorph';
import { TextSwap } from '@/components/motion/TextSwap';
import { makeStyles } from '@/theme';

type Props = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  /** Morph between labels that share letters ("Save" → "Saved") instead of swapping. */
  morph?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function PillButton({ label, onPress, variant = 'primary', disabled, morph, style }: Props) {
  const Label = morph ? TextMorph : TextSwap;
  const styles = useStyles();
  const secondary = variant === 'secondary';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.secondary : disabled ? styles.disabled : styles.primary,
        style,
      ]}
    >
      <Label
        text={label}
        style={[
          styles.label,
          secondary && styles.secondaryLabel,
          disabled && !secondary && styles.disabledLabel,
        ]}
      />
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  button: {
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: c.primary,
  },
  secondary: {
    backgroundColor: c.raised,
  },
  disabled: {
    backgroundColor: c.primaryTint,
  },
  label: {
    color: c.onPrimary,
    fontSize: 19,
    fontWeight: '600',
  },
  secondaryLabel: {
    color: c.text,
  },
  disabledLabel: {
    color: c.disabledText,
  },
}));
