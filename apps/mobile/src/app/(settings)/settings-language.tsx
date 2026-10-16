import { Text } from 'react-native';
import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { LANGUAGES, updateSettings, useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/** App language picker, with each language's flag and a check on the current one. */
export default function LanguageSheet() {
  const styles = useStyles();
  const { language } = useSettings();

  const choose = (next: string) => {
    tap();
    if (next !== language) {
      updateSettings({ language: next });
      showToast(`Language set to ${next}`);
    }
    closeSheet();
  };

  return (
    <SheetScreen title="Language" scroll>
      {LANGUAGES.map(([name, flag]) => (
        <SheetRow
          key={name}
          leading={
            <Text style={styles.flag} accessible={false}>
              {flag}
            </Text>
          }
          title={name}
          accessory="check"
          selected={name === language}
          onPress={() => choose(name)}
        />
      ))}
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  flag: {
    fontSize: 24,
  },
}));
