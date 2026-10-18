import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { SheetRow, SheetRowSkeletons, SheetScreen, SheetSection } from '@/components/sheets/Sheet';
import { EmptyState } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { RECENT_RECIPIENTS, shortAddress } from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { isEvmAddress } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

/** Send, step one: pick who to pay. */
export default function SendSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [query, setQuery] = useState('');
  const loading = useFirstLoad(LOADS.recipients);
  const q = query.trim().toLowerCase();
  const results = RECENT_RECIPIENTS.filter(
    (r) => !q || r.address.toLowerCase().includes(q) || r.label?.toLowerCase().includes(q),
  );

  // A full address that isn't a saved recipient can be sent to directly.
  const typed = query.trim();
  const direct =
    isEvmAddress(typed) && !results.some((r) => r.address.toLowerCase() === typed.toLowerCase())
      ? typed
      : null;

  const choose = (to: string) => {
    tap();
    router.push({ pathname: '/send-amount', params: { to } });
  };

  return (
    <SheetScreen title="Select recipient" scroll>
      <View style={styles.field}>
        <Icon name="search" size={18} color={c.textSecondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Enter address or username"
          placeholderTextColor={c.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {isWeb ? null : (
          <PressableScale
            accessibilityLabel="Scan a QR code"
            hitSlop={8}
            scaleTo={0.97}
            onPress={() => {
              tap();
              router.push('/scan');
            }}
          >
            <Icon name="scan" size={19} color={c.textSecondary} />
          </PressableScale>
        )}
      </View>

      <ContentSwap id={direct ? 'direct' : 'none'}>
        {direct ? (
          <View style={styles.direct}>
            <SheetRow
              leading={<Avatar name={direct} size={38} seed={direct} />}
              title={`Send to ${shortAddress(direct, 6, 4)}`}
              subtitle="New address"
              accessory="chevron"
              onPress={() => choose(direct)}
            />
          </View>
        ) : null}
      </ContentSwap>

      <SheetSection title="Recent" />
      <SkeletonReveal
        loading={loading}
        skeleton={<SheetRowSkeletons count={4} icon={38} trailing={false} />}
      >
        <ContentSwap id={q ? 'search' : 'recent'}>
          {results.map((r) => (
            <SheetRow
              key={r.id}
              leading={<Avatar name={r.label ?? r.address} size={38} seed={r.label ?? r.address} />}
              title={r.label ?? shortAddress(r.address, 8, 6)}
              subtitle={r.label ? shortAddress(r.address, 8, 6) : undefined}
              onPress={() => choose(r.label ?? r.address)}
            />
          ))}
          {results.length === 0 &&
            !direct &&
            (q ? (
              <EmptyState
                compact
                icon="search"
                title="No matches"
                hint="Paste a full address to send to it."
                action={{ label: 'Clear search', onPress: () => setQuery('') }}
              />
            ) : (
              <EmptyState
                compact
                icon="send"
                title="No one yet"
                hint="People you pay show up here. Paste an address or scan a QR code to start."
              />
            ))}
        </ContentSwap>
      </SkeletonReveal>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  input: {
    flex: 1,
    color: c.text,
    fontSize: 16,
  },
  direct: {
    marginTop: 12,
  },
}));
