import type { StyleProp, ViewStyle } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextMorph } from '@/components/motion/TextMorph';
import { TextSwap } from '@/components/motion/TextSwap';
import { makeStyles } from '@/theme';

type Props = {
  label: string;
  onPress: () => void;
  /** `danger` is for the one irreversible action on a screen (e.g. Sign out). */
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  /** Morph between labels that share letters ("Save" → "Saved") instead of swapping. */
  morph?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function PillButton({ label, onPress, variant = 'primary', disabled, morph, style }: Props) {
  const Label = morph ? TextMorph : TextSwap;
  const styles = useStyles();
  const secondary = variant === 'secondary';
  const danger = variant === 'danger';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary
          ? styles.secondary
          : danger
            ? disabled
              ? styles.dangerDisabled
              : styles.danger
            : disabled
              ? styles.disabled
              : styles.primary,
        style,
      ]}
    >
      <Label
        text={label}
        style={[
          styles.label,
          secondary && styles.secondaryLabel,
          danger && !disabled && styles.dangerLabel,
          disabled && !secondary && (danger ? styles.dangerDisabledLabel : styles.disabledLabel),
        ]}
      />
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  button: {
    height: 50,
    // Room either side, so a button sized to its label never crowds it.
    paddingHorizontal: 24,
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
  danger: {
    backgroundColor: c.error,
  },
  dangerLabel: {
    color: '#FFFFFF',
  },
  // Faded red rather than the honey tint, which means a disabled honey button.
  dangerDisabled: {
    backgroundColor: `${c.error}2E`,
  },
  dangerDisabledLabel: {
    color: `${c.error}99`,
  },
  secondaryLabel: {
    color: c.text,
  },
  disabledLabel: {
    color: c.disabledText,
  },
}));
