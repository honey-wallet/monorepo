import { Text, View } from 'react-native';
import { DEMO_BALANCE_NOTICE, DEMO_DEPOSIT_NOTICE } from '@/lib/demo-money-copy';
import { makeStyles } from '@/theme';

export { DEMO_BALANCE_NOTICE, DEMO_DEPOSIT_NOTICE } from '@/lib/demo-money-copy';

export function DemoMoneyNotice({ deposit = false }: { deposit?: boolean }) {
  const styles = useStyles();
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
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  text: {
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
