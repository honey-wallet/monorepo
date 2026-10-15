import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { HeaderIconButton, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

type Item = { id: string; icon: IconName; title: string; hint: string; done: string };

const ITEMS: Item[] = [
  {
    id: 'history',
    icon: 'history',
    title: 'Clear account history',
    hint: 'Transaction history, token balances, recent searches, and pending notifications',
    done: 'Account history cleared',
  },
  {
    id: 'preferences',
    icon: 'person',
    title: 'Clear preferences',
    hint: 'Favorites, swap settings, token warnings, language, and currency',
    done: 'Preferences cleared',
  },
  {
    id: 'cache',
    icon: 'layers',
    title: 'Clear cache',
    hint: 'Temporary data such as token prices',
    done: 'Cache cleared',
  },
];

/**
 * Clears locally cached app data. Wallet keys aren't touched: they stay on the device,
 * and the server never had them.
 */
export default function AppDataScreen() {
  const styles = useStyles();
  const c = useTheme();
  const [cleared, setCleared] = useState<Set<string>>(new Set());

  const clear = (item: Item) => {
    tap();
    setCleared((prev) => new Set(prev).add(item.id));
    showToast(item.done);
  };

  const clearAll = () => {
    tap();
    setCleared(new Set(ITEMS.map((i) => i.id)));
    showToast('All app data cleared');
  };

  return (
    <PushedScreen
      title="App data"
      fallback="/settings"
      right={<HeaderIconButton icon="help" label="Help" onPress={() => router.push('/help')} />}
      contentStyle={styles.content}
      footer={
        <PressableScale
          accessibilityRole="button"
          onPress={clearAll}
          scaleTo={0.98}
          style={styles.clearAll}
        >
          <Icon name="trash" size={19} color={c.text} />
          <Text style={styles.clearAllLabel}>Clear all data</Text>
        </PressableScale>
      }
    >
      <Text style={styles.intro}>
        Clearing app data never touches your recovery phrase or keys. They stay on this device.
      </Text>
      {ITEMS.map((item) => {
        const done = cleared.has(item.id);
        return (
          <PressableScale
            key={item.id}
            accessibilityRole="button"
            accessibilityHint={item.hint}
            scaleTo={0.98}
            onPress={() => clear(item)}
            style={styles.card}
          >
            <IconSwap
              name={done ? 'checkCircle' : item.icon}
              size={22}
              color={done ? c.success : c.textSecondary}
            />
            <View style={styles.flex}>
              <TextSwap
                text={done ? item.done : item.title}
                style={[styles.cardTitle, done && { color: c.textSecondary }]}
              />
              <Text style={styles.cardHint}>{item.hint}</Text>
            </View>
          </PressableScale>
        );
      })}
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 12,
  },
  intro: {
    marginBottom: 4,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  flex: {
    flex: 1,
  },
  card: {
    // A solid card on the page, like every other card (no outline).
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  cardTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  cardHint: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  clearAll: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: c.raised,
  },
  clearAllLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
}));
