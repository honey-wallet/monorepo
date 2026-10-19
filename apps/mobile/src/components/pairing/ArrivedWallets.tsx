import { deriveAddresses, type PairPayload, withMnemonicSeed } from '@honey-wallet/keyring';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { shortAddress } from '@/lib/mock-wallet';
import { makeStyles } from '@/theme';

/** A payload with no names is the phrase's first wallet. */
const accountsOf = (payload: PairPayload) =>
  payload.accounts.length ? payload.accounts : [{ index: 0, label: 'Wallet' }];

/**
 * A pairing's wallets by name and address: what arrived, before it's added, or what's
 * about to leave (the sending phone's confirm step). The
 * receiving device never adds a wallet on its own. Someone who saw the QR could answer
 * before your own device does, so you check these are yours (your other device just
 * took the code) and tap to add them.
 */
export function ArrivedWallets({ payload }: { payload: PairPayload }) {
  const styles = useStyles();
  const [addresses, setAddresses] = useState<Record<number, string>>({});
  const accounts = accountsOf(payload);

  useEffect(() => {
    let live = true;
    void withMnemonicSeed(payload.mnemonic, (seed) => {
      if (!live) return null;
      const next: Record<number, string> = {};
      for (const { index } of accountsOf(payload)) next[index] = deriveAddresses(seed, index).evm;
      setAddresses(next);
      return null;
    });
    return () => {
      live = false;
    };
  }, [payload]);

  return (
    <View style={styles.card}>
      {accounts.map(({ index, label }) => (
        <View key={index} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.address}>
            {addresses[index] ? shortAddress(addresses[index], 6, 4) : '…'}
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  label: {
    flex: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  address: {
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
}));
