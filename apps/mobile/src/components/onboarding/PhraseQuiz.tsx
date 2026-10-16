import { useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { Chip } from '@/components/wallet/Chip';
import { success } from '@/lib/haptics';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

const QUESTIONS = 3;
const CHOICES = 4;

function shuffle<T>(items: T[]) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Three random positions, each with four words to pick from (the right one and three
 * others from the same phrase). Proves the phrase was written down in order without
 * making anyone type it all back.
 */
function makeQuiz(words: string[]) {
  const positions = shuffle(words.map((_, i) => i))
    .slice(0, QUESTIONS)
    .sort((a, b) => a - b);
  return positions.map((index) => {
    const answer = words[index] as string;
    const others = shuffle([...new Set(words.filter((w) => w !== answer))]).slice(0, CHOICES - 1);
    return { index, answer, choices: shuffle([answer, ...others]) };
  });
}

export function PhraseQuiz({ words, onPass }: { words: string[]; onPass: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const [quiz] = useState(() => makeQuiz(words));
  const [picked, setPicked] = useState<Record<number, string>>({});

  const pick = (index: number, word: string, answer: string) => {
    if (picked[index]) return;
    if (word !== answer) {
      showToast(`That’s not word #${index + 1}. Check what you wrote down`);
      return;
    }
    const next = { ...picked, [index]: word };
    setPicked(next);
    if (Object.keys(next).length === quiz.length) {
      success();
      onPass();
    }
  };

  return (
    <View style={styles.list}>
      {quiz.map(({ index, answer, choices }, i) => (
        <Animated.View
          key={index}
          entering={FadeIn.duration(DURATION.fast).delay(i * DURATION.stagger)}
          style={styles.card}
        >
          <View style={styles.head}>
            <Text style={styles.label}>Word #{index + 1}</Text>
            {picked[index] ? <Icon name="check" size={16} color={c.success} /> : null}
          </View>
          <View style={styles.choices}>
            {choices.map((word) => (
              <Chip
                key={word}
                label={word}
                accessibilityRole="radio"
                selected={picked[index] === word}
                onPress={() => pick(index, word, answer)}
              />
            ))}
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  list: {
    gap: 12,
  },
  card: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  head: {
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    color: c.textSecondary,
    fontSize: 15,
  },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
}));
