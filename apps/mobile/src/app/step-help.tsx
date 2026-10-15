import { useLocalSearchParams } from 'expo-router';
import type { IconName } from '@/components/Icon';
import { PillButton } from '@/components/onboarding/PillButton';
import type { HelpTopic } from '@/components/onboarding/StepScreen';
import { closeSheet, SheetRow, SheetScreen, SheetText } from '@/components/wallet/Sheet';

type Help = { title: string; intro: string; points: [IconName, string, string][] };

const contact = (thing: 'email' | 'phone number'): Help => ({
  title: `Why we ask for your ${thing}`,
  intro: `Your ${thing} is how Honey knows it's you. It never holds or controls your money.`,
  points: [
    ['checkCircle', "Confirm it's you", `We send a one-time code to check the ${thing} is yours.`],
    ['bell', 'Security alerts', 'We tell you when something important changes on your wallet.'],
    ['mail', 'No spam', `We only contact you about your account, and never sell your ${thing}.`],
    [
      'lock',
      "It can't move your money",
      `Your keys stay on this phone, so no one can use your ${thing} to take your funds.`,
    ],
  ],
});

const HELP: Record<HelpTopic, Help> = {
  email: contact('email'),
  phone: contact('phone number'),
  code: {
    title: "Didn't get a code?",
    intro: 'Codes usually arrive within a minute.',
    points: [
      ['mail', 'Check your spam folder', 'Look for a message from Honey with a 6-digit code.'],
      ['clock', 'Wait, then resend', 'You can ask for a new code after 30 seconds.'],
      ['pencil', 'Check the address', 'Go back to fix a typo in your email or phone number.'],
    ],
  },
};

/** Help for an onboarding step, opened from its "?" button. */
export default function StepHelpSheet() {
  const { topic = 'email' } = useLocalSearchParams<{ topic?: HelpTopic }>();
  const help = HELP[topic] ?? HELP.email;
  return (
    <SheetScreen title={help.title} footer={<PillButton label="Got it" onPress={closeSheet} />}>
      <SheetText>{help.intro}</SheetText>
      {help.points.map(([icon, title, subtitle]) => (
        <SheetRow key={title} icon={icon} title={title} subtitle={subtitle} />
      ))}
    </SheetScreen>
  );
}
