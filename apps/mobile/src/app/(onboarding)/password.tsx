// NOT IN THE FLOW FOR NOW: verify goes straight to the wallet (see lib/onboarding.ts).
// Kept as is so it can come back; nothing links here.
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { EyeIcon } from '@/components/onboarding/icons';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { makeStyles, useTheme } from '@/theme';

export default function PasswordScreen() {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const styles = useStyles();
  const stepStyles = useStepStyles();
  const c = useTheme();
  const next = () => password.length > 0 && router.push('/name');

  return (
    <StepScreen
      title="Enter your password"
      footer={<PillButton label="Continue" disabled={password.length === 0} onPress={next} />}
    >
      <View style={styles.field}>
        <TextInput
          autoFocus
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!visible}
          selectionColor={c.accentText}
          cursorColor={c.accentText}
          textContentType="password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          onSubmitEditing={next}
          style={[stepStyles.input, styles.input]}
        />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={visible ? 'Hide password' : 'Show password'}
          hitSlop={12}
          onPress={() => setVisible((v) => !v)}
          style={styles.eye}
        >
          <Swap id={visible ? 'hide' : 'show'} size={22}>
            <EyeIcon color={c.textSecondary} off={visible} />
          </Swap>
        </PressableScale>
      </View>

      <View style={styles.forgot}>
        <Text style={styles.forgotText}>Forgot Password?</Text>
        <Text style={styles.reset}>Reset Password</Text>
      </View>
    </StepScreen>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
  },
  eye: {
    marginLeft: 12,
    marginBottom: 4,
  },
  forgot: {
    marginTop: 38,
    flexDirection: 'row',
    gap: 7,
  },
  forgotText: {
    color: c.textSecondary,
    fontSize: 16,
  },
  reset: {
    color: c.accentText,
    fontSize: 16,
  },
}));
