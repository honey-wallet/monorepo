import type { VersionInfo } from '@honey-wallet/api-client';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, useColorScheme } from 'react-native';
import { api, apiBaseUrl } from '@/lib/api';

type Status =
  | { state: 'loading' }
  | { state: 'online'; info: VersionInfo }
  | { state: 'offline'; message: string };

export default function HomeScreen() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const dark = useColorScheme() === 'dark';

  const load = useCallback(async () => {
    try {
      setStatus({ state: 'online', info: await api.version() });
    } catch (error) {
      setStatus({
        state: 'offline',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={[styles.title, dark && styles.textDark]}>Honey Wallet</Text>
      <Text
        style={[
          styles.status,
          status.state === 'online' && styles.online,
          status.state === 'offline' && styles.offline,
          status.state === 'loading' && dark && styles.textDark,
        ]}
      >
        {status.state === 'loading' && 'Connecting to server…'}
        {status.state === 'online' && `Connected to ${status.info.name} v${status.info.version}`}
        {status.state === 'offline' && `Server unreachable: ${status.message}`}
      </Text>
      <Text style={styles.hint}>API: {apiBaseUrl}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  textDark: {
    color: '#e5e7eb',
  },
  status: {
    fontSize: 16,
    textAlign: 'center',
  },
  online: {
    color: '#16a34a',
  },
  offline: {
    color: '#dc2626',
  },
  hint: {
    fontSize: 12,
    color: '#6b7280',
  },
});
