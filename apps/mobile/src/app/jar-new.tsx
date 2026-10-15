import { useState } from 'react';
import { Keyboard, Text, TextInput, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { applyKey, Keypad, TypedAmount } from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { closeSheet, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { addJar, JAR_TOKENS, usdValue } from '@/lib/jars';
import { formatUsd } from '@/lib/mock-wallet';
import { useSectionPrefs } from '@/lib/section-prefs';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const STABLE = new Set(['USDC', 'USDT']);

/** New Honey Jar: a name, a token and a goal. */
export default function NewJarSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [name, setName] = useState('');
  // Starts on the currency chosen in Savings settings.
  const [symbol, setSymbol] = useState<string>(useSectionPrefs().savingsJarToken);
  const [goal, setGoal] = useState('');
  const value = Number(goal) || 0;
  const stable = STABLE.has(symbol);
  const label = !name.trim() ? 'Name your jar' : !value ? 'Set a goal' : 'Create jar';

  const create = () => {
    tap();
    addJar({ name: name.trim(), symbol, goal: value });
    showToast('Jar created');
    closeSheet();
  };

  return (
    <SheetScreen
      title="New Honey Jar"
      size="fill"
      footer={<PillButton label={label} disabled={!name.trim() || !value} onPress={create} />}
    >
      <View style={styles.field}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="What are you saving for?"
          placeholderTextColor={c.placeholder}
          maxLength={32}
          returnKeyType="done"
          style={styles.input}
        />
      </View>

      <View style={styles.tokens}>
        {JAR_TOKENS.map((s) => (
          <PressableScale
            key={s}
            accessibilityRole="button"
            accessibilityState={{ selected: s === symbol }}
            onPress={() => {
              tap();
              Keyboard.dismiss();
              setSymbol(s);
              setGoal('');
            }}
            style={[styles.token, s === symbol && styles.tokenActive]}
          >
            <TokenIcon symbol={s} size={22} />
            <Text style={[styles.tokenLabel, s === symbol && styles.tokenLabelActive]}>{s}</Text>
          </PressableScale>
        ))}
      </View>

      <View style={styles.amountArea}>
        <Text style={styles.goalLabel}>Goal</Text>
        <View style={styles.amountRow}>
          <TypedAmount value={goal} prefix={stable ? '$' : ''} size={goal.length > 8 ? 44 : 56} />
          {stable ? null : <Text style={styles.unit}>{symbol}</Text>}
        </View>
        <TextSwap
          text={stable ? `in ${symbol}` : `≈ ${formatUsd(usdValue(symbol, value))}`}
          style={styles.convert}
        />
      </View>

      <Keypad
        onKey={(key) => {
          Keyboard.dismiss();
          setGoal((g) => applyKey(g, key, stable ? 2 : 8));
        }}
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  input: {
    color: c.text,
    fontSize: 17,
  },
  tokens: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  token: {
    flex: 1,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.divider,
  },
  tokenActive: {
    borderColor: c.primary,
    backgroundColor: c.accentSurface,
  },
  tokenLabel: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  tokenLabelActive: {
    color: c.text,
  },
  amountArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  goalLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unit: {
    color: c.textSecondary,
    fontSize: 28,
    fontWeight: '500',
  },
  convert: {
    color: c.textSecondary,
    fontSize: 15,
  },
}));
