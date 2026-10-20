import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetScreen } from '@/components/sheets/Sheet';
import { type AppIconName, changeAppIcon, getAppIcon, supportsAppIcons } from '@/lib/app-icon';
import { tap } from '@/lib/haptics';
import { isWeb } from '@/lib/platform';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

const OPTIONS = [
  // Honey is the dark icon, the default; Light is the white one.
  { name: null, label: 'Honey', image: require('../../../assets/images/icon.png') },
  { name: 'Light', label: 'Light', image: require('../../../assets/images/icon-light.png') },
  {
    name: 'Midnight',
    label: 'Midnight',
    image: require('../../../assets/images/icon-midnight.png'),
  },
  {
    name: 'Graphite',
    label: 'Graphite',
    image: require('../../../assets/images/icon-graphite.png'),
  },
] as const;

export default function AppIconSheet() {
  // Browsers have no app icon: a deep link lands back where it can go.
  if (isWeb) return <Redirect href="/settings" />;
  return <AppIconSheetContent />;
}

function AppIconSheetContent() {
  const styles = useStyles();
  const c = useTheme();
  const [selected, setSelected] = useState(getAppIcon);
  const [pending, setPending] = useState<string | null>(null);
  const changing = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !changing.current) setSelected(getAppIcon());
    });
    return () => subscription.remove();
  }, []);

  const choose = async (name: AppIconName, label: string) => {
    if (!supportsAppIcons || changing.current || name === selected) return;
    changing.current = true;
    setPending(label);
    setError(null);
    tap();
    try {
      setSelected(await changeAppIcon(name));
      showToast('App icon changed');
    } catch (error) {
      console.error('Unable to change app icon', error);
      setError('Couldn’t change the app icon. Please try again.');
    } finally {
      changing.current = false;
      setPending(null);
    }
  };

  return (
    <SheetScreen title="App icon">
      <View style={styles.options} accessibilityRole="radiogroup">
        {OPTIONS.map((option) => (
          <PressableScale
            key={option.label}
            accessibilityRole="radio"
            accessibilityLabel={`${option.label} app icon`}
            accessibilityState={{
              checked: selected === option.name,
              disabled: !supportsAppIcons || pending !== null,
              busy: pending === option.label,
            }}
            disabled={!supportsAppIcons || pending !== null}
            onPress={() => void choose(option.name, option.label)}
            style={styles.option}
          >
            <View
              style={[
                styles.outline,
                { borderColor: selected === option.name ? c.accentText : 'transparent' },
              ]}
            >
              <Image source={option.image} style={styles.icon} />
              {pending === option.label ? (
                <View style={styles.pending}>
                  <ActivityIndicator color={c.text} />
                </View>
              ) : null}
            </View>
            <Text style={styles.label}>{option.label}</Text>
          </PressableScale>
        ))}
      </View>
      {!supportsAppIcons ? (
        <Text style={styles.hint}>App icons can be changed in the installed Honey app.</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  options: {
    flexDirection: 'row',
    gap: 14,
    paddingTop: 8,
  },
  option: { flex: 1, gap: 10, alignItems: 'center' },
  outline: { width: '100%', aspectRatio: 1, padding: 4, borderWidth: 2, ...radius(27) },
  icon: { width: '100%', height: '100%', ...radius(20) },
  label: { fontSize: 13, color: c.textSecondary },
  pending: {
    position: 'absolute',
    top: 4,
    left: 4,
    right: 4,
    bottom: 4,
    ...radius(20),
    backgroundColor: c.card,
    opacity: 0.85,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { fontSize: 14, lineHeight: 20, color: c.textSecondary, marginTop: 16 },
  error: { fontSize: 14, lineHeight: 20, color: c.error, marginTop: 16 },
}));
