import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const FRAME = 260;
const CORNER = 44;

/** Full-screen QR scanner. The camera needs a real device; simulators show the frame only. */
export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  /** A code from the camera or a photo: go straight to sending to that address. */
  const onCode = (data: string) => {
    if (handled.current) return;
    handled.current = true;
    tap();
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
          scaleTo={0.9}
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
          first={<Text style={styles.title}>Scan a QR code</Text>}
        />
        <View style={styles.frame}>
          {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
            <View key={corner} style={[styles.corner, styles[corner]]} />
          ))}
          {!permission?.granted && (
            <View style={styles.permission}>
              <Text style={styles.permissionText}>Honey needs your camera to scan codes.</Text>
              <PillButton
                label="Allow camera"
                onPress={requestPermission}
                style={styles.permissionButton}
              />
            </View>
          )}
        </View>
        <PressableScale
          accessibilityLabel="Choose from photos"
          scaleTo={0.9}
          onPress={scanPhoto}
          style={styles.photo}
        >
          <Icon name="photo" size={18} color="#FFFFFF" />
        </PressableScale>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + SCREEN.footerBottom }]}>
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
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '600',
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
  photo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
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
