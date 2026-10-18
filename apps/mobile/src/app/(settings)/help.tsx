import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { PressableRow } from '@/components/motion/PressableRow';
import { EmptyState, ScreenHeader } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import { isWeb } from '@/lib/platform';
import { makeStyles, useTheme } from '@/theme';

const FAQ: { q: string; a: string }[] = [
  {
    q: 'What is self-custody?',
    a: 'Self-custody means you alone hold the keys to your wallet. Honey creates them on your device and keeps them there — our servers never see them. That also means nobody, including Honey, can move your funds or reset your access for you.',
  },
  {
    q: 'How do I back up my wallet?',
    a: 'Go to Settings › Recovery phrase and write the 12 words down on paper, in order. You can also turn on cloud backup in Settings, which stores an encrypted copy that only you can unlock.',
  },
  {
    q: 'I lost my phone. What now?',
    a: 'Install Honey on a new device, choose "Import a wallet", and enter your recovery phrase or restore from your cloud backup. Without either one, the wallet can\'t be recovered.',
  },
  {
    q: 'What are network fees?',
    a: 'Every transaction pays a small fee to the blockchain network, not to Honey. Fees rise and fall with demand. Honey picks a fee automatically; you can change this in Settings › Advanced › Network cost.',
  },
  {
    q: 'Is Honey quantum-safe?',
    a: "Honey is designed so your wallet can rotate to new keys and signature schemes as post-quantum standards arrive on each network. That's a design for the future, not a guarantee against every attack.",
  },
  {
    q: 'What are Honey Jars?',
    a: 'Honey Jars are savings goals. Set a target, add funds whenever you like, and watch the jar fill. Some jars earn a variable yield, which can change and is never guaranteed.',
  },
  {
    q: 'Which chains are supported?',
    // a: 'Honey supports Bitcoin, Ethereum, Solana, Tron and the XRP Ledger, with more on the way. Switch networks from the network picker on the home screen.',
    a: 'Honey supports Bitcoin, Solana, and Ethereum, Base and other EVM networks, with more on the way. Switch networks from the network picker on the home screen.',
  },
  {
    q: 'How do I contact support?',
    a: 'Tap "Contact us" below or in Settings. We reply within a day. We\'ll never ask for your recovery phrase — anyone who does is a scammer.',
  },
];

/** Searchable FAQ, with a way to reach a person. */
export default function HelpScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const results = q
    ? FAQ.filter((f) => f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q))
    : FAQ;

  const contact = (
    <PressableRow
      accessibilityRole="button"
      onPress={() => {
        tap();
        router.push('/contact');
      }}
      style={[styles.contact, isWeb && styles.contactPinned]}
    >
      <View style={styles.contactIcon}>
        <Icon name="chat" size={18} color={c.accentText} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.contactTitle}>Still need help?</Text>
        <Text style={styles.contactHint}>Contact us</Text>
      </View>
      <Icon name="chevronRight" size={15} color={c.textSecondary} />
    </PressableRow>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader title="Help center" />
      <View style={styles.searchWrap}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search help articles" />
      </View>

      <ScrollView
        alwaysBounceVertical={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <Text style={styles.section}>Frequently asked</Text>
        {results.length === 0 ? (
          <EmptyState
            icon="search"
            title="No results"
            hint={`Nothing matches "${query.trim()}". Try another word, or ask us directly.`}
            action={{ label: 'Contact us', onPress: () => router.push('/contact') }}
          />
        ) : (
          results.map((f) => {
            const isOpen = open === f.q;
            return (
              <View key={f.q} style={styles.item}>
                <PressableRow
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isOpen }}
                  onPress={() => {
                    tap();
                    setOpen(isOpen ? null : f.q);
                  }}
                  style={styles.question}
                >
                  <Text style={styles.questionText}>{f.q}</Text>
                  <AccordionChevron open={isOpen} size={13} color={c.textSecondary} />
                </PressableRow>
                <Accordion open={isOpen}>
                  <Text style={styles.answer}>{f.a}</Text>
                </Accordion>
              </View>
            );
          })
        )}

        {isWeb ? null : contact}
      </ScrollView>
      {/* review: in the 600px popup the FAQ list pushed the way to a person below the
      fold; there it stays pinned under the list. */}
      {isWeb ? contact : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  flex: {
    flex: 1,
  },
  searchWrap: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  section: {
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 20,
    color: c.textSecondary,
    fontSize: 15,
  },
  item: {
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
    marginHorizontal: 20,
  },
  question: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: -20,
    paddingHorizontal: 20,
  },
  questionText: {
    flex: 1,
    color: c.text,
    fontSize: 17,
  },
  answer: {
    paddingBottom: 16,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  contact: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  contactPinned: {
    marginTop: 0,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: c.divider,
  },
  contactIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  contactTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  contactHint: {
    marginTop: 2,
    color: c.accentText,
    fontSize: 15,
  },
}));
