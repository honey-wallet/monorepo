import type { ReactNode } from 'react';
import { type StyleProp, TextInput, View, type ViewStyle } from 'react-native';
import { Icon } from '@/components/Icon';
import { makeStyles, useTheme } from '@/theme';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Something at the right end, e.g. the token picker's network filter. */
  trailing?: ReactNode;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** The one search field: a rounded pill with a magnifier, used by every search. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  trailing,
  autoFocus,
  style,
}: Props) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={[styles.field, style]}>
      <Icon name="search" size={18} color={c.textSecondary} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.placeholder}
        selectionColor={c.primary}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode={trailing ? 'never' : 'while-editing'}
        accessibilityLabel={placeholder}
        style={styles.input}
      />
      {trailing}
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
  input: {
    flex: 1,
    height: '100%',
    color: c.text,
    fontSize: 17,
  },
}));
