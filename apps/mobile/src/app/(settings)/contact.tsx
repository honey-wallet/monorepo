import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen, SheetSection, SheetText } from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { tap } from '@/lib/haptics';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

const TOPICS = ['Account', 'Transactions', 'Security', 'Other'] as const;
type Topic = (typeof TOPICS)[number];

/** Send the Honey team a message, filed under a topic. */
export default function ContactSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [topic, setTopic] = useState<Topic>('Account');
  const [message, setMessage] = useState('');
  const ready = message.trim().length > 0;

  const send = () => {
    tap();
    showToast('Message sent');
    closeSheet();
  };

  return (
    <SheetScreen
      title="Contact us"
      footer={<PillButton label="Send" disabled={!ready} onPress={send} />}
    >
      <SheetText lead>We reply within a day.</SheetText>

      <SheetSection title="Topic" />
      <View style={styles.chips}>
        {TOPICS.map((t) => {
          const selected = t === topic;
          return (
            <Chip
              key={t}
              label={t}
              variant="filled"
              accessibilityRole="radio"
              selected={selected}
              onPress={() => setTopic(t)}
            />
          );
        })}
      </View>

      <SheetSection title="Message" />
      <TextInput
        value={message}
        onChangeText={setMessage}
        placeholder="Tell us what's going on. Never share your recovery phrase."
        placeholderTextColor={c.placeholder}
        multiline
        textAlignVertical="top"
        style={styles.input}
        selectionColor={c.primary}
        accessibilityLabel="Message"
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  input: {
    minHeight: 96,
    padding: 14,
    ...radius(16),
    color: c.text,
    fontSize: 16,
    lineHeight: 22,
    backgroundColor: c.card,
  },
}));
