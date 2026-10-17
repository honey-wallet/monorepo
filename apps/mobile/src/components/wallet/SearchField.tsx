// Search input and clearing are immediate. Old text must never linger over a new query.
import type { ReactNode } from 'react';
import { type StyleProp, TextInput, View, type ViewStyle } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { PRESS_SCALE } from '@/theme/motion';

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
 * `trailing` it shows a ✕ while there's text.
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
  const clear = () => {
    tap();
    onChangeText('');
  };

  return (
    <View style={[styles.field, style]}>
      <Icon name="search" size={18} color={c.textSecondary} />
      <View style={styles.inputArea}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
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
      </View>
      {trailing ??
        (value ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={13}
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
  clear: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.placeholder,
  },
}));
