import { Text, View } from 'react-native';
import { SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { makeStyles, radius } from '@/theme';

/** Keeps preview-only markets from implying that a wallet action was submitted. */
export function ExecutionUnavailable({ message }: { message: string }) {
  const styles = useStyles();
  if (!SHOW_DEMO_LABELS) return null;
  return (
    <View accessibilityLabel={`Preview only. ${message}`} style={styles.container}>
      <Text style={styles.title}>Preview only</Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: {
    marginTop: 12,
    padding: 12,
    ...radius(12),
    backgroundColor: c.card,
    gap: 3,
  },
  title: {
    color: c.text,
    fontSize: 13,
    fontWeight: '600',
  },
  message: {
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
}));
