import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { KeyGlyph, PhraseGlyph } from '@/components/onboarding/icons';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { finishOnboarding } from '@/lib/onboarding';
import { showToast } from '@/lib/toast';
import { importMnemonic, importPrivateKey, isValidMnemonic } from '@/lib/vault';
import { addVaultWallet } from '@/lib/wallets';
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
  const { kind, onboarding } = useLocalSearchParams<{
    kind?: 'phrase' | 'key';
    onboarding?: string;
  }>();
  const isKey = kind === 'key';
  // A private key is one field; a phrase is one cell per word, like the paper it's copied from.
  const [keyText, setKeyText] = useState('');
  const [target, setTarget] = useState<12 | 24>(12);
  const [slots, setSlots] = useState<string[]>(() => Array(24).fill(''));
  const cells = useRef<(TextInput | null)[]>([]);
  const [busy, setBusy] = useState(false);

  const words = slots.slice(0, target).filter(Boolean);
  const phrase = isKey ? keyText : words.join(' ');
  const key = keyOf(keyText);
  const badWord = (w: string) => !/^[a-z]+$/.test(w);
  const invalid = isKey ? /[^0-9a-f]/i.test(key) : words.some(badWord);
  const complete = isKey ? key.length === 64 && !invalid : words.length === target && !invalid;
  // Every word is real but the last one doesn't match: a typo or the wrong order.
  const badChecksum = !isKey && complete && !isValidMnemonic(phrase);
  // As few words as the screen needs: what to enter, where it stays, one warning.
  const copy = isKey
    ? {
        title: 'Enter your private key',
        subtitle: 'It stays on this phone.',
        placeholder: '0x…',
        count: `${key.length}/64`,
        cta: complete ? 'Import' : 'Enter your key',
        hint: invalid ? 'Only 0–9 and a–f.' : '',
      }
    : {
        title: 'Enter your recovery phrase',
        subtitle: 'It stays on this phone.',
        placeholder: '',
        count: `${words.length}/${target}`,
        cta: complete ? 'Import' : `Enter ${target} words`,
        hint: invalid
          ? 'Letters only.'
          : badChecksum
            ? 'These words don’t match. Check the spelling and order.'
            : '',
      };

  /** Puts `list` into the cells from `from` on, then moves to the cell after the last one. */
  const fill = (from: number, list: string[]) => {
    const size = from + list.length > 12 ? 24 : target;
    setTarget(size);
    setSlots((prev) => {
      const next = [...prev];
      list.slice(0, 24 - from).forEach((w, i) => {
        next[from + i] = w;
      });
      return next;
    });
    const after = Math.min(from + list.length, size - 1);
    cells.current[after]?.focus();
  };

  // A space (or a pasted run of words) spills into the following cells.
  const onCell = (i: number, text: string) => {
    const list = wordsOf(text);
    if (/\s/.test(text) && list.length > 0) fill(i, list);
    else setSlots((prev) => prev.map((w, j) => (j === i ? text.trim().toLowerCase() : w)));
  };

  const paste = async () => {
    tap();
    const text = await Clipboard.getStringAsync();
    if (!text) {
      showToast('Clipboard is empty');
      return;
    }
    if (isKey) setKeyText(text.trim());
    else {
      const list = wordsOf(text).slice(0, 24);
      setSlots(Array.from({ length: 24 }, (_, i) => list[i] ?? ''));
      setTarget(list.length > 12 ? 24 : 12);
    }
  };

  const half = target / 2;
  // Two columns read top to bottom (1–6, then 7–12), the way it's written on paper.
  const column = (start: number) => (
    <View style={styles.column}>
      {Array.from({ length: half }, (_, k) => {
        const i = start + k;
        const word = slots[i];
        return (
          <View key={i} style={[styles.cell, word && badWord(word) && styles.cellError]}>
            <Text style={styles.cellNumber}>{i + 1}</Text>
            <TextInput
              ref={(el) => {
                cells.current[i] = el;
              }}
              value={word}
              onChangeText={(text) => onCell(i, text)}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === 'Backspace' && !word && i > 0)
                  cells.current[i - 1]?.focus();
              }}
              onSubmitEditing={() => cells.current[i + 1]?.focus()}
              returnKeyType={i === target - 1 ? 'done' : 'next'}
              blurOnSubmit={i === target - 1}
              accessibilityLabel={`Word ${i + 1}`}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              style={styles.cellInput}
            />
          </View>
        );
      })}
    </View>
  );

  const submit = async () => {
    tap();
    setBusy(true);
    try {
      const account = isKey
        ? await importPrivateKey(key, 'Imported wallet')
        : await importMnemonic(phrase, 'Imported wallet');
      addVaultWallet(account);
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : 'Couldn’t import this wallet');
      return;
    }
    // From onboarding, the imported wallet is the wallet: open it, money and all.
    if (onboarding) {
      finishOnboarding('import');
      return;
    }
    showToast('Wallet imported');
    router.dismissAll();
  };

  const pasteButton = (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Paste from clipboard"
      onPress={paste}
      style={styles.paste}
    >
      <Icon name="copy" size={13} color={c.text} />
      <Text style={styles.pasteLabel}>Paste</Text>
    </PressableScale>
  );

  return (
    // The button stays inline under the field rather than pinned as a footer, so
    // it sits above the keyboard while typing.
    <SheetScreen>
      <View style={styles.glyph}>
        {isKey ? (
          <KeyGlyph color={c.accentText} size={22} />
        ) : (
          <PhraseGlyph color={c.accentText} size={22} />
        )}
      </View>
      <TextsReveal
        id={`import-${isKey ? 'key' : 'phrase'}`}
        first={<Text style={styles.title}>{copy.title}</Text>}
        second={<Text style={styles.subtitle}>{copy.subtitle}</Text>}
      />

      {isKey ? (
        <View style={[styles.field, invalid && styles.fieldError]}>
          <TextInput
            value={keyText}
            onChangeText={setKeyText}
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
            {pasteButton}
          </View>
        </View>
      ) : (
        <>
          <View style={styles.gridHeader}>
            <TextSwap text={copy.count} style={[styles.count, complete && styles.countDone]} />
            <View style={styles.gridActions}>
              <Text
                accessibilityRole="button"
                style={styles.switchLength}
                onPress={() => {
                  tap();
                  setTarget(target === 12 ? 24 : 12);
                }}
              >
                {target === 12 ? '24 words' : '12 words'}
              </Text>
              {pasteButton}
            </View>
          </View>
          <View style={styles.grid}>
            {column(0)}
            {column(half)}
          </View>
        </>
      )}
      {/* Only when something's wrong. */}
      {copy.hint ? <Text style={[styles.hint, styles.hintError]}>{copy.hint}</Text> : null}

      <View style={styles.rule}>
        <Icon name="warning" size={15} color={c.textSecondary} />
        <Text style={styles.ruleText}>Never share it. Anyone with it can take your funds.</Text>
      </View>

      <PillButton
        label={busy ? 'Importing…' : copy.cta}
        disabled={!complete || badChecksum || busy}
        onPress={submit}
        style={styles.cta}
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  glyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
    marginBottom: 14,
  },
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  subtitle: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  field: {
    marginTop: 18,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: c.raised,
  },
  fieldError: {
    borderColor: c.error,
  },
  input: {
    minHeight: 96,
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
  gridHeader: {
    marginTop: 18,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gridActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  switchLength: {
    color: c.accentText,
    fontSize: 14,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    gap: 10,
  },
  column: {
    flex: 1,
    gap: 8,
  },
  cell: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'transparent',
    // Raised, not card: on the tray's own surface a card-coloured cell vanishes in dark mode.
    backgroundColor: c.raised,
  },
  cellError: {
    borderColor: c.error,
  },
  cellNumber: {
    width: 20,
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  cellInput: {
    flex: 1,
    height: '100%',
    paddingRight: 12,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  hint: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 14,
  },
  hintError: {
    color: c.error,
  },
  rule: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  ruleText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  cta: {
    marginTop: 20,
  },
}));
