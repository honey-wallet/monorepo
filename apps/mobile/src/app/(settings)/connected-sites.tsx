import type { Site } from '@honey-wallet/extension/protocol';
import { evmNetwork } from '@honey-wallet/keyring';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetRow, SheetRowSkeletons, SheetScreen } from '@/components/sheets/Sheet';
import { connectedSites, disconnectSite } from '@/lib/dapp';
import { tap } from '@/lib/haptics';
import { hostOf } from '@/lib/multisig';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/** Honey for Chrome: the websites that can see a wallet, and a way to cut them off. */
export default function ConnectedSitesSheet() {
  const styles = useStyles();
  const [sites, setSites] = useState<Site[] | null>(null);
  useEffect(() => {
    void connectedSites().then((list) =>
      setSites([...list].sort((a, b) => b.connectedAt - a.connectedAt)),
    );
  }, []);

  const disconnect = async (site: Site) => {
    tap();
    await disconnectSite(site.origin);
    setSites((prev) => prev?.filter((s) => s.origin !== site.origin) ?? null);
    showToast(`Disconnected ${hostOf(site.origin)}`);
  };

  return (
    <SheetScreen title="Connected sites">
      {sites === null ? (
        <SheetRowSkeletons count={3} icon={22} />
      ) : sites.length === 0 ? (
        <Text style={styles.empty}>
          No sites yet. When you connect Honey to one, it shows here.
        </Text>
      ) : (
        sites.map((site) => (
          <SheetRow
            key={site.origin}
            icon="globe"
            title={hostOf(site.origin)}
            subtitle={`${site.walletName} · ${
              site.evm ? (evmNetwork(site.chainId)?.name ?? `Chain ${site.chainId}`) : 'Solana'
            }`}
            accessory={
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${hostOf(site.origin)}`}
                onPress={() => disconnect(site)}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Disconnect</Text>
              </PressableScale>
            }
          />
        ))
      )}
      <View style={styles.gap} />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  empty: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: c.raised,
  },
  buttonText: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },
  gap: {
    height: 8,
  },
}));
