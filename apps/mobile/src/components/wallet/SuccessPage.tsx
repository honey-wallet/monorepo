import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { SuccessCheck } from '@/components/motion/SuccessCheck';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SHEET } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { showDemoToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/**
 * The last page of a money flow (send, buy, deposit, an order): the check draws on,
 * then what happened, centred in the space it's given. With `onDone`, a Done button
 * sits at the bottom; sheets with a pinned footer put their own there instead.
 */
export function SuccessPage({
  title,
  detail,
  onDone,
}: {
  title: string;
  detail: string;
  onDone?: () => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.page}>
      <View style={styles.flex} />
      <View style={styles.body}>
        <SuccessCheck />
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      <View style={styles.flex} />
      {onDone ? <PillButton label="Done" onPress={onDone} style={styles.cta} /> : null}
    </View>
  );
}

/**
 * Leaves a finished demo flow: says nothing really happened, then closes the sheet
 * (or, with `all`, every sheet back to the screen underneath).
 */
export function finishDemo(what: string, { all = false }: { all?: boolean } = {}) {
  tap();
  showDemoToast(what);
  if (all) router.dismissAll();
  else closeSheet();
}

const useStyles = makeStyles((c) => ({
  page: {
    flex: 1,
    minHeight: 320,
  },
  flex: {
    flex: 1,
  },
  body: {
    alignItems: 'center',
  },
  title: {
    marginTop: 16,
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
  },
  detail: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));
