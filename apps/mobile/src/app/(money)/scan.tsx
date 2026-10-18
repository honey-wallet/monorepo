import { parsePairUri } from '@honey-wallet/keyring';
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { holdScannedOffer, offerDirection } from '@/lib/pair-offer';
import { showToast } from '@/lib/toast';
import { isWalletConnectUri, pairWalletConnect } from '@/lib/walletconnect';
import { isEvmAddress } from '@/lib/wallets';
import { holdWatchedAddress } from '@/lib/watch-scan';
import { makeStyles, useTheme } from '@/theme';

const FRAME = 260;
const CORNER = 44;

/** Full-screen QR scanner. The camera needs a real device; simulators show the frame only. */
export default function ScanScreen() {
  const { purpose } = useLocalSearchParams<{ purpose?: string }>();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  /**
   * A code from the camera or a photo: a browser's pairing code opens pairing; a
   * WalletConnect code connects that site (it then asks in the approval screen);
   * anything else is an address, so go straight to sending to it.
   */
  const onCode = (data: string) => {
    if (handled.current) return;
    handled.current = true;
    tap();
    if (purpose === 'watch') {
      const address = data.replace(/^ethereum:/i, '').split(/[?@]/)[0];
      if (!isEvmAddress(address)) {
        showToast('Scan an EVM wallet address');
        handled.current = false;
        return;
      }
      holdWatchedAddress(address);
      router.back();
      return;
    }
    // From onboarding (no wallet yet): only Honey for Chrome's "Send wallet to phone" code.
    if (purpose === 'pair') {
      if (offerDirection(data) !== 'toPhone') {
        showToast('In the browser extension, open Settings › Send wallet to phone');
        handled.current = false;
        return;
      }
      holdScannedOffer(data);
      router.replace({ pathname: '/pair-extension', params: { onboarding: '1' } });
      return;
    }
    // From the setup checklist: only Honey for Chrome's "Pair with your phone" code.
    if (purpose === 'extension' && offerDirection(data) !== 'toBrowser') {
      showToast('In the browser extension, choose I already have a wallet › Pair with your phone');
      handled.current = false;
      return;
    }
    if (isWalletConnectUri(data)) {
      router.back();
      showToast('Connecting to the site…');
      pairWalletConnect(data.trim()).catch(() =>
        showToast('That code expired. Get a new one from the site'),
      );
      return;
    }
    if (parsePairUri(data)) {
      // Passed in memory, not as a route param, so only this scanner can start pairing.
      holdScannedOffer(data);
      router.replace('/pair-extension');
      return;
    }
    showToast('Address scanned');
    // Payment links look like "ethereum:0xabc…@1?value=…"; keep just the address.
    const to = data.replace(/^[a-z]+:/i, '').split(/[?@]/)[0] || data;
    router.replace({ pathname: '/send-amount', params: { to } });
  };

  const scanPhoto = async () => {
    tap();
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (picked.canceled) return;
    const [code] = await scanFromURLAsync(picked.assets[0].uri, ['qr']);
    if (code) onCode(code.data);
    else showToast('No QR code found in that photo');
  };

  const close = () => goBackOr('/home');

  return (
    <View style={styles.root}>
      {permission?.granted && (
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onCode(data)}
        />
      )}
      <View style={styles.dim} />

      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <PressableScale
          accessibilityLabel="Close"
          hitSlop={10}
          scaleTo={0.97}
          onPress={close}
          style={styles.close}
        >
          <Icon name="close" size={16} color="#FFFFFF" />
        </PressableScale>
      </View>

      <View style={styles.center}>
        <TextsReveal
          id="scan"
          align="center"
          first={
            <Text style={styles.title}>
              {/* {purpose === 'pair' || purpose === 'extension'
                ? 'Scan the code in the browser extension'
                : 'Scan a QR code'} */}
              {purpose === 'pair' || purpose === 'extension'
                ? 'Scan the extension’s code'
                : 'Scan a QR code'}
            </Text>
          }
          // One short line under it, centred, instead of a two-line title (review).
          second={
            purpose === 'pair' || purpose === 'extension' ? (
              <Text style={styles.hint}>
                It’s in Honey in your browser, under Pair with your phone.
              </Text>
            ) : undefined
          }
        />
        <View style={styles.frame}>
          {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
            <View key={corner} style={[styles.corner, styles[corner]]} />
          ))}
          {/* Nothing until the permission is known, so "Allow camera" doesn't flash up
              for someone who already allowed it. Once iOS stops asking, only Settings can. */}
          {permission && !permission.granted && (
            <View style={styles.permission}>
              <Text style={styles.permissionText}>
                {permission.canAskAgain
                  ? 'Honey needs your camera to scan codes.'
                  : 'Camera access is off. Turn it on in Settings to scan codes.'}
              </Text>
              <PillButton
                label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
                onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
                style={styles.permissionButton}
              />
            </View>
          )}
        </View>
        <PressableScale
          accessibilityLabel="Choose from photos"
          scaleTo={0.97}
          onPress={scanPhoto}
          style={styles.photo}
        >
          <Icon name="photo" size={18} color="#FFFFFF" />
          <Text style={styles.photoLabel}>Choose from photos</Text>
        </PressableScale>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + SCREEN.footerBottom }]}>
        {/* No wallet yet while onboarding, so no QR code of yours to show. */}
        {purpose === 'pair' ? null : (
          <PressableScale
            onPress={() => {
              tap();
              // From the scanner, My QR offers a way back to scanning.
              router.replace({ pathname: '/my-qr', params: { from: 'scan' } });
            }}
            style={styles.myQr}
          >
            <Icon name="qr" size={18} color={c.text} />
            <Text style={styles.myQrLabel}>Show my QR code</Text>
          </PressableScale>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  top: {
    paddingHorizontal: 20,
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
  },
  title: {
    paddingHorizontal: 32,
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  hint: {
    marginTop: 8,
    paddingHorizontal: 40,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  frame: {
    width: FRAME,
    height: FRAME,
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: '#FFFFFF',
  },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 24 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 24 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 24 },
  br: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 24,
  },
  permission: {
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
  },
  permissionText: {
    color: '#FFFFFF',
    fontSize: 15,
    textAlign: 'center',
  },
  permissionButton: {
    paddingHorizontal: 22,
  },
  // A labelled pill, so it says what it does (review: cleaner scanner).
  photo: {
    flexDirection: 'row',
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  photoLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  bottom: {
    alignItems: 'center',
  },
  myQr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    paddingHorizontal: 22,
    borderRadius: 26,
    backgroundColor: c.raised,
  },
  myQrLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
}));
