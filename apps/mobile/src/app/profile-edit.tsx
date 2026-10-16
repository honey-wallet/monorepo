import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Avatar, randomAvatarSeed } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { Swap } from '@/components/motion/IconSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetHeader, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { ADDRESS, shortAddress } from '@/lib/mock-wallet';
import { setProfile, useProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const AVATAR = 88;

/** Edit the name and photo: all a wallet profile needs, and all anyone sees. */
export default function ProfileEditSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [name, setName] = useState(profile.name);
  const [photo, setPhoto] = useState(profile.photo);
  const [seed, setSeed] = useState(profile.avatarSeed);
  const [menuOpen, setMenuOpen] = useState(false);

  const changed =
    name.trim() !== profile.name || photo !== profile.photo || seed !== profile.avatarSeed;
  const valid = name.trim().length > 0;

  const choosePhoto = async () => {
    tap();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled) setPhoto(result.assets[0].uri);
  };

  const save = () => {
    tap();
    setProfile({ name: name.trim(), photo, avatarSeed: seed });
    showToast('Profile saved');
    closeSheet();
  };

  const menu = (action: () => void) => () => {
    tap();
    setMenuOpen(false);
    action();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <SheetScreen
        size="fill"
        footer={<PillButton label="Save" disabled={!changed || !valid} onPress={save} />}
      >
        {/* Standard header, plus a ••• button on the right for photo options. */}
        <View>
          <SheetHeader
            title="Edit profile"
            onBack={() => {
              tap();
              closeSheet();
            }}
          />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="More options"
            accessibilityState={{ expanded: menuOpen }}
            hitSlop={12}
            scaleTo={0.97}
            onPress={() => {
              tap();
              setMenuOpen((v) => !v);
            }}
            style={styles.more}
          >
            <Icon name="more" size={20} color={c.textSecondary} />
          </PressableScale>
        </View>

        <Accordion open={menuOpen}>
          <View style={styles.menu}>
            <MenuRow icon="photo" label="Choose photo" onPress={menu(choosePhoto)} />
            <MenuRow
              icon="sparkles"
              label="Shuffle avatar"
              onPress={menu(() => {
                setPhoto(null);
                setSeed(randomAvatarSeed());
              })}
            />
            {photo ? (
              <MenuRow icon="trash" label="Remove photo" onPress={menu(() => setPhoto(null))} />
            ) : null}
          </View>
        </Accordion>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          alwaysBounceVertical={false}
          style={styles.flex}
        >
          <View style={styles.identity}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Change profile photo"
              scaleTo={0.97}
              onPress={choosePhoto}
              style={styles.avatarRing}
            >
              <Swap id={photo ?? seed} size={AVATAR}>
                <Avatar name={name} size={AVATAR} uri={photo} seed={seed} />
              </Swap>
              <View style={styles.pencil}>
                <Icon name="pencil" size={13} color={c.onPrimary} />
              </View>
            </PressableScale>
            <Text style={styles.address}>{shortAddress(ADDRESS)}</Text>
          </View>

          <View style={styles.fields}>
            <Field label="Name">
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                placeholderTextColor={c.placeholder}
                style={styles.input}
                selectionColor={c.primary}
                maxLength={32}
                autoCorrect={false}
                accessibilityLabel="Name"
              />
            </Field>
          </View>
        </ScrollView>
      </SheetScreen>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.flex}>{children}</View>
    </View>
  );
}

function MenuRow({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableRow onPress={onPress} style={styles.menuRow}>
      <Icon name={icon} size={17} color={c.text} />
      <Text style={styles.menuLabel}>{label}</Text>
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  more: {
    position: 'absolute',
    right: 0,
    top: 0,
    height: 44,
    justifyContent: 'center',
  },
  menu: {
    marginTop: 4,
    marginBottom: 8,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: c.raised,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 46,
    paddingHorizontal: 16,
  },
  menuLabel: {
    color: c.text,
    fontSize: 16,
  },
  identity: {
    marginTop: 24,
    alignItems: 'center',
  },
  avatarRing: {
    padding: 4,
    borderRadius: AVATAR / 2 + 4,
    backgroundColor: c.sheet,
  },
  pencil: {
    position: 'absolute',
    right: 0,
    bottom: 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
    borderWidth: 3,
    borderColor: c.card,
  },
  address: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 16,
  },
  fields: {
    marginTop: 28,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    gap: 12,
  },
  fieldLabel: {
    width: 72,
    paddingTop: 2,
    color: c.textSecondary,
    fontSize: 17,
  },
  input: {
    padding: 0,
    color: c.text,
    fontSize: 16,
    lineHeight: 22,
  },
}));
