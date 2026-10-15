import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { showToast } from '@/lib/toast';
import { addWallet, demoAddress } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/** Splits a typed or pasted phrase into lowercase words. */
function wordsOf(text: string) {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** A private key: 64 hex characters, with or without a 0x prefix. */
const keyOf = (text: string) => text.trim().replace(/^0x/i, '');

/**
 * Import a wallet from its 12 or 24 word recovery phrase (`kind=phrase`, the
 * default) or a single wallet's private key (`kind=key`). Nothing leaves the device.
 */
export default function ImportWalletSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { kind } = useLocalSearchParams<{ kind?: 'phrase' | 'key' }>();
  const isKey = kind === 'key';
  const [phrase, setPhrase] = useState('');

  const words = wordsOf(phrase);
  const target = words.length > 12 ? 24 : 12;
  const key = keyOf(phrase);
  const invalid = isKey ? /[^0-9a-f]/i.test(key) : words.some((w) => !/^[a-z]+$/.test(w));
  const complete = isKey
    ? key.length === 64 && !invalid
    : (words.length === 12 || words.length === 24) && !invalid;
  const copy = isKey
    ? {
        title: 'Enter your private key',
        subtitle: 'Your key stays on this device. Honey never sees or stores it.',
        placeholder: '0x…',
        count: `${key.length} / 64 characters`,
        cta: complete ? 'Import wallet' : 'Enter 64 characters',
        hint: invalid
          ? 'A private key only uses 0–9 and a–f.'
          : 'Paste the key exported from your other wallet.',
        warning: 'Never share your private key. Anyone with it can take the funds in this wallet.',
      }
    : {
        title: 'Enter your recovery phrase',
        subtitle: 'Your phrase stays on this device. Honey never sees or stores it.',
        placeholder: 'word1 word2 word3 …',
        count: `${words.length} / ${target} words`,
        cta: complete ? 'Continue' : `Enter ${target} words`,
        hint: invalid
          ? 'Words should only contain letters.'
          : 'Enter the words in order, separated by spaces.',
        warning: 'Never share your recovery phrase. Anyone with it can take your funds.',
      };

  const paste = async () => {
    tap();
    const text = await Clipboard.getStringAsync();
    if (text) setPhrase(isKey ? text.trim() : wordsOf(text).join(' '));
    else showToast('Clipboard is empty');
  };

  const submit = () => {
    tap();
    // TODO: derive the address from the phrase or key on-device; demo address for now.
    addWallet({ kind: 'wallet', label: 'Imported wallet', address: demoAddress(), usd: 0 });
    showToast('Wallet imported');
    router.dismissAll();
  };

  return (
    // The button stays inline under the field rather than pinned as a footer, so
    // it sits above the keyboard while typing.
    <SheetScreen
      title={isKey ? 'Import private key' : 'Import recovery phrase'}
      size="fill"
      onBack={() => {
        tap();
        closeSheet();
      }}
    >
      <TextsReveal
        id={`import-${isKey ? 'key' : 'phrase'}`}
        align="center"
        first={<Text style={styles.title}>{copy.title}</Text>}
        second={<Text style={styles.subtitle}>{copy.subtitle}</Text>}
      />

      <View style={[styles.field, invalid && styles.fieldError]}>
        <TextInput
          value={phrase}
          onChangeText={setPhrase}
          placeholder={copy.placeholder}
          placeholderTextColor={c.placeholder}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          textAlignVertical="top"
          style={styles.input}
        />
        <View style={styles.fieldFooter}>
          <TextSwap text={copy.count} style={[styles.count, complete && styles.countDone]} />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Paste from clipboard"
            onPress={paste}
            style={styles.paste}
          >
            <Icon name="copy" size={13} color={c.text} />
            <Text style={styles.pasteLabel}>Paste</Text>
          </PressableScale>
        </View>
      </View>
      <TextSwap text={copy.hint} style={[styles.hint, invalid && styles.hintError]} />

      <PillButton label={copy.cta} disabled={!complete} onPress={submit} style={styles.cta} />
      <View style={styles.warning}>
        <Icon name="warning" size={14} color={c.accentText} />
        <Text style={styles.warningText}>{copy.warning}</Text>
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  field: {
    marginTop: 22,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.divider,
    backgroundColor: c.raised,
  },
  fieldError: {
    borderColor: c.error,
  },
  input: {
    minHeight: 120,
    padding: 0,
    color: c.text,
    fontSize: 17,
    lineHeight: 24,
  },
  fieldFooter: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  count: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  countDone: {
    color: c.success,
  },
  paste: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: c.raised,
  },
  pasteLabel: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 14,
  },
  hintError: {
    color: c.error,
  },
  cta: {
    marginTop: 24,
  },
  warning: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: 14,
    backgroundColor: c.accentSurface,
  },
  warningText: {
    flex: 1,
    color: c.accentText,
    fontSize: 13,
    lineHeight: 18,
  },
}));
