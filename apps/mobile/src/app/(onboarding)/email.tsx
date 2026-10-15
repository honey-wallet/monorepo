import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { useTheme } from '@/theme';

const EMAIL = /^\S+@\S+\.\S+$/;

export default function EmailScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<'email' | 'phone'>(params.mode === 'phone' ? 'phone' : 'email');
  const [value, setValue] = useState('');
  const stepStyles = useStepStyles();
  const c = useTheme();
  const isEmail = mode === 'email';
  const valid = isEmail ? EMAIL.test(value.trim()) : value.replace(/\D/g, '').length >= 7;

  const switchMode = () => {
    setMode(isEmail ? 'phone' : 'email');
    setValue('');
  };

  return (
    <StepScreen
      leading="close"
      help={isEmail ? 'email' : 'phone'}
      title={isEmail ? 'Enter your email address' : 'Enter your phone number'}
      footer={
        <View style={stepStyles.footerRow}>
          <PillButton
            variant="secondary"
            label={isEmail ? 'Use Phone' : 'Use Email'}
            onPress={switchMode}
            style={stepStyles.footerButton}
          />
          <PillButton
            label="Continue"
            disabled={!valid}
            onPress={() => router.push({ pathname: '/verify', params: { to: value.trim() } })}
            style={stepStyles.footerButton}
          />
        </View>
      }
    >
      <TextInput
        key={mode}
        autoFocus
        value={value}
        onChangeText={setValue}
        placeholder={isEmail ? 'Email Address' : 'Phone Number'}
        placeholderTextColor={c.placeholder}
        selectionColor={c.accentText}
        cursorColor={c.accentText}
        keyboardType={isEmail ? 'email-address' : 'phone-pad'}
        textContentType={isEmail ? 'emailAddress' : 'telephoneNumber'}
        autoComplete={isEmail ? 'email' : 'tel'}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType={isEmail ? 'next' : undefined}
        onSubmitEditing={() =>
          valid && router.push({ pathname: '/verify', params: { to: value.trim() } })
        }
        style={stepStyles.input}
      />
    </StepScreen>
  );
}
