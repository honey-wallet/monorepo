import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  Keyframe,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { Checkbox } from '@/components/motion/Checkbox';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PhraseQuiz } from '@/components/onboarding/PhraseQuiz';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { InlineTray } from '@/components/sheets/Tray';
import { PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { completeStep, finishOnboarding } from '@/lib/onboarding';
import { createPhraseAccess } from '@/lib/phrase-access';
import { isWeb } from '@/lib/platform';
import { getProfile } from '@/lib/profile';
import { usePreventScreenCapture } from '@/lib/screen-capture';
import { showErrorToast } from '@/lib/toast';
import { startWithMnemonic } from '@/lib/vault';
import { addVaultWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

/** Phrases are 12 words here (24-word imports are shown from Settings too). */
const PLACEHOLDER = Array<string>(12).fill('');

// Words rise in one after another, 40ms apart. Revealing the phrase is a rare,
// first-time moment, so each word may take the longer 400ms on a strong ease-out.
// Under Reduce Motion the rise is dropped and only the fade remains (gentler, not
// zero): Reanimated would otherwise skip the entrance entirely.
const rise = (index: number, reduced: boolean) =>
  reduced
    ? FadeIn.duration(DURATION.fast).reduceMotion(ReduceMotion.Never)
    : new Keyframe({
        0: { opacity: 0, transform: [{ translateY: DISTANCE.medium }] },
        100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
      })
        .duration(DURATION.verySlow)
        .delay(index * DURATION.stagger);

// The old bottom panel's motion; the warning is a tray now, which animates itself.
// const panelIn = lazy(() =>
//   new Keyframe({
//     0: { opacity: 0, transform: [{ translateY: 40 }] },
//     100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
//   }).duration(DURATION.medium),
// );

// const panelOut = lazy(() =>
//   new Keyframe({
//     0: { opacity: 1, transform: [{ translateY: 0 }] },
//     100: { opacity: 0, transform: [{ translateY: 40 }], easing: EASE.smoothOut },
//   }).duration(DURATION.fast),
// );

/** Shows the recovery phrase, but only after a "view this in private" warning. */
export default function RecoveryPhraseScreen() {
  // From onboarding ("Create with a recovery phrase"), writing it down creates the wallet.
  const params = useLocalSearchParams<{ onboarding?: string }>();
  const [access] = useState(() => createPhraseAccess(params.onboarding === '1'));
  const onboarding = access.isDraft;
  const viewing = useRef(false);
  const styles = useStyles();
  const c = useTheme();
  const [warning, setWarning] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [writtenDown, setWrittenDown] = useState(false);
  const [creating, setCreating] = useState(false);
  // Onboarding only: after "written down", pick three of the words before creating.
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  // From onboarding, a brand-new phrase that's only saved once it's written down.
  // From Settings, the device's phrase, read from secure storage (null if none yet).
  const [phrase, setPhrase] = useState<string | null | undefined>(() => access.draft);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        if (state === 'background') access.cancel();
        setRevealed(false);
        setWarning(true);
        if (!onboarding) setPhrase(undefined);
      }
    });
    return () => {
      access.cancel();
      sub.remove();
    };
  }, [onboarding, access]);
  const words = phrase ? phrase.split(' ') : PLACEHOLDER;
  const half = words.length / 2;
  const missing = phrase === null;

  const create = async () => {
    if (!phrase) return;
    tap();
    setCreating(true);
    try {
      addVaultWallet(await startWithMnemonic(phrase, getProfile().name));
      finishOnboarding('phrase');
    } catch (error) {
      console.warn('Couldn’t save the recovery phrase', error);
      setCreating(false);
      showErrorToast('Couldn’t create wallet');
    }
  };

  // No screenshots or recordings while the phrase can be on screen.
  usePreventScreenCapture();

  // A saved phrase needs Face ID (or the passcode) first; a brand-new one doesn't.
  const view = async () => {
    if (viewing.current) return;
    viewing.current = true;
    tap();
    try {
      const result = await access.read();
      if (!result || AppState.currentState !== 'active') return;
      const value = result.phrase;
      if (!onboarding) setPhrase(value);
      setWarning(false);
      setRevealed(!!value);
    } catch {
      showErrorToast('Couldn’t read phrase');
    } finally {
      viewing.current = false;
    }
  };

  const close = () => {
    tap();
    goBackOr(onboarding ? '/welcome' : '/settings');
  };

  const toggleHidden = () => {
    tap();
    if (revealed) setRevealed(false);
    else setWarning(true);
  };

  const reduceMotion = useReducedMotion();
  // Two columns read top to bottom (1–6, then 7–12), the way it's written on paper.
  const column = (start: number) => (
    <View style={styles.column}>
      {words.slice(start, start + half).map((word, i) => (
        // Words can repeat within a phrase, so they're keyed by position.
        // biome-ignore lint/suspicious/noArrayIndexKey: a phrase's order never changes
        <View key={start + i} style={styles.tile}>
          <Text style={styles.index}>{start + i + 1}</Text>
          {revealed && word ? (
            <Animated.Text entering={rise(start + i, reduceMotion)} style={styles.wordText}>
              {word}
            </Animated.Text>
          ) : (
            <View style={styles.flex}>
              <SkeletonBar width="70%" height={10} radius={5} />
            </View>
          )}
        </View>
      ))}
    </View>
  );

  const hero = checking
    ? {
        title: 'Check your phrase',
        body: 'Tap the right word for each number.',
      }
    : missing
      ? {
          title: 'No recovery phrase yet',
          body: 'Create or import a wallet first.',
        }
      : onboarding
        ? {
            title: 'Write down your recovery phrase',
            body: 'Write them on paper, in order. Keep it safe.',
          }
        : {
            title: 'Your recovery phrase',
            body: 'Never share them or type them into a website.',
          };

  return (
    <PushedScreen
      title={onboarding ? (checking ? '2 of 2' : '1 of 2') : 'Recovery phrase'}
      fallback={onboarding ? '/welcome' : '/settings'}
      footer={
        onboarding && checking ? (
          <PillButton
            label={creating ? 'Creating…' : 'Create wallet'}
            disabled={!checked || creating}
            onPress={create}
            style={styles.flexButton}
          />
        ) : onboarding && revealed ? (
          <PillButton
            label="Continue"
            disabled={!writtenDown}
            style={styles.flexButton}
            onPress={() => {
              tap();
              setRevealed(false);
              setChecking(true);
            }}
          />
        ) : undefined
      }
      // Fits a phone as is; the browser's 600px popup may need to scroll (step 2's quiz).
      scroll={isWeb}
      contentStyle={styles.content}
      // The privacy warning rises in a tray (Family's pattern): one line, then Close or View.
      overlay={
        <InlineTray onClose={close}>
          {warning ? (
            <SheetScreen>
              <View style={[styles.warnTile, { backgroundColor: `${c.error}1F` }]}>
                <Icon name="warning" size={22} color={c.error} />
              </View>
              <Text style={styles.panelTitle}>Check no one can see</Text>
              <Text style={styles.panelBody}>Anyone with these words can take your funds.</Text>
              <View style={styles.buttons}>
                <PillButton
                  label="Close"
                  variant="secondary"
                  onPress={close}
                  style={styles.flexButton}
                />
                <PillButton label="View" onPress={view} style={styles.flexButton} />
              </View>
            </SheetScreen>
          ) : null}
        </InlineTray>
      }
    >
      <View style={styles.hero}>
        <TextsReveal
          id={hero.title}
          first={<Text style={styles.title}>{hero.title}</Text>}
          second={<Text style={styles.body}>{hero.body}</Text>}
        />
      </View>

      {checking ? (
        <>
          <PhraseQuiz words={words} onPass={() => setChecked(true)} />
          <PressableScale
            accessibilityRole="button"
            onPress={() => {
              tap();
              setChecking(false);
              setChecked(false);
              setRevealed(true);
            }}
            scaleTo={0.97}
            style={styles.textButton}
          >
            <Text style={styles.textButtonLabel}>See the phrase again</Text>
          </PressableScale>
        </>
      ) : missing ? null : (
        <>
          <View>
            <View
              style={styles.grid}
              accessibilityLabel={revealed ? words.join(' ') : 'Recovery phrase, hidden'}
            >
              {column(0)}
              {column(half)}
            </View>
            {/* Hidden: one clear way to show it again, over the blank tiles. */}
            {!revealed && !warning ? (
              <Animated.View
                entering={FadeIn.duration(DURATION.fast)}
                style={styles.revealWrap}
                pointerEvents="box-none"
              >
                <PressableScale
                  accessibilityRole="button"
                  onPress={toggleHidden}
                  scaleTo={0.97}
                  style={styles.reveal}
                >
                  <Icon name="eye" size={18} color={c.text} />
                  <Text style={styles.revealLabel}>Show phrase</Text>
                </PressableScale>
              </Animated.View>
            ) : null}
          </View>

          {revealed ? (
            <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.below}>
              {/* In a browser, ticking this later is how the setup checklist's backup gets done. */}
              {onboarding || isWeb ? (
                <Checkbox
                  label="I’ve written it down somewhere safe"
                  checked={writtenDown}
                  onChange={(checked) => {
                    setWrittenDown(checked);
                    if (checked && !onboarding) completeStep('backup');
                  }}
                />
              ) : (
                <View />
              )}
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Hide phrase"
                onPress={toggleHidden}
                scaleTo={0.97}
                hitSlop={10}
                style={styles.hideButton}
              >
                <IconSwap name="eyeSlash" size={16} color={c.textSecondary} />
                <Text style={styles.hideLabel}>Hide</Text>
              </PressableScale>
            </Animated.View>
          ) : null}
        </>
      )}
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  flex: {
    flex: 1,
  },
  hero: {
    marginBottom: isWeb ? 16 : 24,
  },
  title: {
    color: c.text,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.4,
  },
  body: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  grid: {
    flexDirection: 'row',
    gap: 10,
  },
  column: {
    flex: 1,
    gap: 10,
  },
  tile: {
    height: isWeb ? 44 : 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  index: {
    width: 20,
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  wordText: {
    flex: 1,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  revealWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reveal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: c.canvas,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  revealLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  below: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  hideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  hideLabel: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '500',
  },
  textButton: {
    marginTop: 24,
    alignSelf: 'center',
    paddingVertical: 8,
  },
  textButtonLabel: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  fill: {
    flex: 1,
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 36,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: c.card,
  },
  warnTile: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelTitle: {
    marginTop: 14,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  panelBody: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  buttons: {
    marginTop: 26,
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 12,
  },
  flexButton: {
    flex: 1,
  },
}));
