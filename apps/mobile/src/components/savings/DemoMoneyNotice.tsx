import { Text, View } from 'react-native';
import { DEMO_BALANCE_NOTICE, DEMO_DEPOSIT_NOTICE, SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { makeStyles, radius } from '@/theme';

export { DEMO_BALANCE_NOTICE, DEMO_DEPOSIT_NOTICE } from '@/lib/demo-money-copy';

export function DemoMoneyNotice({ deposit = false }: { deposit?: boolean }) {
  const styles = useStyles();
  if (!SHOW_DEMO_LABELS) return null;
  return (
    <View accessibilityRole="text" style={styles.notice}>
      <Text style={styles.text}>{deposit ? DEMO_DEPOSIT_NOTICE : DEMO_BALANCE_NOTICE}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  notice: {
    marginBottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
    ...radius(14),
    backgroundColor: c.card,
  },
  text: {
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
