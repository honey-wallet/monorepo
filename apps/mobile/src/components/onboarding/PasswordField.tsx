import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { EyeIcon } from '@/components/onboarding/icons';
import { makeStyles, useTheme } from '@/theme';

/** A password box with a show/hide eye, on the raised surface used by fields in trays. */
export function PasswordField({
  value,
  onChangeText,
  onSubmit,
  placeholder = 'Password',
  autoFocus,
  error,
  isNew,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  error?: boolean;
  /** A password being chosen (vs. typed to unlock), for the browser's password manager. */
  isNew?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [visible, setVisible] = useState(false);
  return (
    <View style={[styles.field, error && styles.fieldError]}>
      <TextInput
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={c.placeholder}
        secureTextEntry={!visible}
        selectionColor={c.accentText}
        cursorColor={c.accentText}
        textContentType={isNew ? 'newPassword' : 'password'}
        autoComplete={isNew ? 'new-password' : 'current-password'}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        accessibilityLabel={placeholder}
        style={styles.input}
      />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide password' : 'Show password'}
        hitSlop={12}
        onPress={() => setVisible((v) => !v)}
        style={styles.eye}
      >
        <Swap id={visible ? 'hide' : 'show'} size={20}>
          <EyeIcon size={20} color={c.textSecondary} off={visible} />
        </Swap>
      </PressableScale>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: c.raised,
  },
  fieldError: {
    borderColor: c.error,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    color: c.text,
    fontSize: 17,
  },
  eye: {
    marginLeft: 10,
  },
}));
