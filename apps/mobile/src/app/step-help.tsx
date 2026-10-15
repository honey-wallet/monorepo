import { useLocalSearchParams } from 'expo-router';
import type { IconName } from '@/components/Icon';
import { PillButton } from '@/components/onboarding/PillButton';
import type { HelpTopic } from '@/components/onboarding/StepScreen';
import { closeSheet, SheetRow, SheetScreen, SheetText } from '@/components/wallet/Sheet';

type Help = { title: string; intro?: string; points: [IconName, string, string][] };

const contact = (thing: 'email' | 'phone number'): Help => ({
  title: `Why your ${thing}?`,
  points: [
    ['checkCircle', 'Sign in', 'We send you a one-time code.'],
    ['bell', 'Security alerts', 'Only about your wallet. No spam.'],
    ['lock', "Can't move your money", 'Your keys stay on this phone.'],
  ],
});

const HELP: Record<HelpTopic, Help> = {
  email: contact('email'),
  phone: contact('phone number'),
  code: {
    title: "Didn't get a code?",
    points: [
      ['mail', 'Check spam', 'Look for a 6-digit code from Honey.'],
      ['clock', 'Resend', 'Ask for a new one after 30 seconds.'],
      ['pencil', 'Check the address', 'Go back to fix a typo.'],
    ],
  },
};

/** Help for an onboarding step, opened from its "?" button. */
export default function StepHelpSheet() {
  const { topic = 'email' } = useLocalSearchParams<{ topic?: HelpTopic }>();
  const help = HELP[topic] ?? HELP.email;
  return (
    <SheetScreen title={help.title} footer={<PillButton label="Got it" onPress={closeSheet} />}>
      {help.intro ? <SheetText>{help.intro}</SheetText> : null}
      {help.points.map(([icon, title, subtitle]) => (
        <SheetRow key={title} icon={icon} title={title} subtitle={subtitle} />
      ))}
    </SheetScreen>
  );
}
