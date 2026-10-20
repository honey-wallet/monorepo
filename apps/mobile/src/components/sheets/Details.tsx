// The pieces of a detail sheet (a proposal, a transaction), so they all read the same:
// a status pill under the title, rounded groups of rows with a quiet title above each,
// hashes you tap to copy, and a link out to the block explorer.
import type { ReactNode } from 'react';
import { Linking, Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { makeStyles, radius, useTheme } from '@/theme';

/** A rounded block of rows, with an optional quiet title above it. */
export function DetailGroup({ title, children }: { title?: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={styles.group}>{children}</View>
    </>
  );
}

/** Where something stands, as a small pill: done (green), waiting (honey) or failed. */
export function StatusPill({
  tone,
  icon,
  text,
}: {
  tone: 'done' | 'waiting' | 'failed';
  icon: IconName;
  text: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const color = tone === 'done' ? c.success : tone === 'failed' ? c.error : c.accentText;
  return (
    <View style={[styles.pill, tone === 'waiting' && styles.pillWaiting]}>
      <Icon name={icon} size={13} color={color} />
      <Text style={[styles.pillText, { color }]}>{text}</Text>
    </View>
  );
}

/** A hash or address, shortened; tapping copies it in full (the icon swaps to a check). */
export function Copyable({
  value,
  toast,
  short = true,
}: {
  value: string;
  toast: string;
  short?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const { copied, copy } = useCopy(value, toast);
  return (
    <PressableScale
      accessibilityLabel={toast.replace(' copied', '')}
      onPress={copy}
      hitSlop={8}
      style={styles.inline}
    >
      <Text style={styles.value}>{short ? shortAddress(value) : value}</Text>
      <IconSwap name={copied ? 'check' : 'copy'} size={14} color={c.textSecondary} />
    </PressableScale>
  );
}

/** A small link-out icon to see this on a block explorer. */
export function ExplorerLink({ name, url }: { name: string; url: string }) {
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="link"
      accessibilityLabel={`View on ${name}`}
      hitSlop={10}
      onPress={() => {
        tap();
        Linking.openURL(url).catch(() => {});
      }}
    >
      <Icon name="link" size={14} color={c.textSecondary} />
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  title: {
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  group: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    ...radius(20),
    backgroundColor: c.card,
  },
  pill: {
    marginTop: 2,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: c.card,
  },
  pillWaiting: {
    backgroundColor: c.accentSurface,
  },
  pillText: {
    fontSize: 14,
    fontWeight: '500',
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  value: {
    color: c.text,
    fontSize: 16,
  },
}));
