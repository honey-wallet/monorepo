// NOT IN THE FLOW FOR NOW: verify goes straight to the wallet (see lib/onboarding.ts).
// Kept as is so it can come back; nothing links here.
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { useTheme } from '@/theme';

export default function NameScreen() {
  const [name, setName] = useState('');
  const stepStyles = useStepStyles();
  const c = useTheme();
  const trimmed = name.trim();

  const next = () => {
    if (trimmed) router.push({ pathname: '/avatar', params: { name: trimmed } });
  };

  return (
    <StepScreen
      title={'What should we\ncall you?'}
      footer={<PillButton label="Continue" disabled={!trimmed} onPress={next} />}
    >
      <TextInput
        autoFocus
        value={name}
        onChangeText={setName}
        placeholder="Your Name"
        placeholderTextColor={c.placeholder}
        selectionColor={c.accentText}
        cursorColor={c.accentText}
        textContentType="name"
        autoComplete="name"
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="next"
        onSubmitEditing={next}
        style={stepStyles.input}
      />
      <Text style={stepStyles.hint}>This is how you’ll appear in Honey.</Text>
    </StepScreen>
  );
}
