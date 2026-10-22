import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Avatar, randomAvatarSeed } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { IconSwap, Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetHeader, SheetScreen } from '@/components/sheets/Sheet';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { setProfile, useProfile } from '@/lib/profile';
import { receiveAddresses } from '@/lib/receive';
import { showToast } from '@/lib/toast';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

const AVATAR = 104;
const MAX_NAME = 32;

/**
 * Edit the name and photo: all a wallet profile needs, and all anyone sees. Photo
 * actions sit in plain sight under the avatar rather than behind a ••• menu.
 */
export default function ProfileEditSheet() {
  const styles = useStyles();
  const wallet = useActiveWallet();
  const c = useTheme();
  const profile = useProfile();
  const [name, setName] = useState(profile.name);
  const [photo, setPhoto] = useState(profile.photo);
  const [seed, setSeed] = useState(profile.avatarSeed);
  const address = receiveAddresses(wallet)[0]?.address ?? '';
  const { copied, copy } = useCopy(address, 'Address copied');

  const trimmed = name.trim();
  const changed =
    trimmed !== profile.name || photo !== profile.photo || seed !== profile.avatarSeed;
  const valid = trimmed.length > 0;

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

  const shuffle = () => {
    tap();
    setPhoto(null);
    setSeed(randomAvatarSeed());
  };

  const save = () => {
    tap();
    setProfile({ name: trimmed, photo, avatarSeed: seed });
    showToast('Profile saved');
    closeSheet();
  };

  return (
    // Sized to its content: the photo, the name and Save, nothing more. iOS lifts a
    // fitted sheet over the keyboard, and Save sits right under the field.
    <SheetScreen>
      <SheetHeader title="Edit profile" />

      <View style={styles.identity}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Change profile photo"
          scaleTo={0.97}
          onPress={choosePhoto}
          style={styles.ring}
        >
          <Swap id={photo ?? seed} size={AVATAR}>
            <Avatar name={trimmed || 'You'} size={AVATAR} uri={photo} seed={seed} />
          </Swap>
        </PressableScale>

        <View style={styles.actions}>
          <Action icon="photo" label="Choose photo" onPress={choosePhoto} />
          <Action icon="sparkles" label="Shuffle" onPress={shuffle} />
          {photo ? (
            <Action
              icon="trash"
              label="Remove"
              onPress={() => {
                tap();
                setPhoto(null);
              }}
            />
          ) : null}
        </View>
      </View>

      <Text style={styles.section}>Display name</Text>
      <View style={[styles.field, !valid && styles.fieldError]}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={c.placeholder}
          style={styles.input}
          selectionColor={c.primary}
          cursorColor={c.accentText}
          maxLength={MAX_NAME}
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => changed && valid && save()}
          accessibilityLabel="Display name"
        />
        {name ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Clear name"
            hitSlop={10}
            onPress={() => {
              tap();
              setName('');
            }}
            style={styles.clear}
          >
            <Icon name="close" size={11} color={c.sheet} />
          </PressableScale>
        ) : null}
      </View>
      <View style={styles.hintRow}>
        <TextSwap
          text={valid ? 'Shown on your wallet' : 'Add a name so friends know it’s you'}
          style={[styles.hint, !valid && { color: c.error }]}
        />
        <Text style={styles.count}>
          {name.length}/{MAX_NAME}
        </Text>
      </View>

      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Copy wallet address"
        onPress={copy}
        scaleTo={0.98}
        style={styles.address}
      >
        <View style={styles.addressWell}>
          <Icon name="wallet" size={16} color={c.accentText} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.addressLabel}>Wallet address</Text>
          <Text style={styles.addressValue}>
            {address ? shortAddress(address, 6, 4) : 'Receive unavailable'}
          </Text>
        </View>
        <IconSwap name={copied ? 'check' : 'copy'} size={16} color={c.textSecondary} />
      </PressableScale>

      <PillButton label="Save" disabled={!changed || !valid} onPress={save} style={styles.save} />
    </SheetScreen>
  );
}

/** A small grey pill under the avatar: one photo action. */
function Action({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      onPress={onPress}
      scaleTo={0.96}
      style={styles.action}
    >
      <Icon name={icon} size={14} color={c.text} />
      <Text style={styles.actionLabel}>{label}</Text>
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  identity: {
    marginTop: 12,
    alignItems: 'center',
  },
  // A soft honey halo around the photo, so it reads as the thing to tap.
  ring: {
    padding: 4,
    borderRadius: AVATAR / 2 + 4,
    backgroundColor: c.accentSurface,
  },
  actions: {
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  action: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: c.raised,
  },
  actionLabel: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },
  section: {
    marginTop: 28,
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 15,
  },
  field: {
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    ...radius(20),
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: c.card,
  },
  fieldError: {
    borderColor: c.error,
  },
  input: {
    flex: 1,
    padding: 0,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  clear: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.placeholder,
  },
  hintRow: {
    marginTop: 8,
    paddingHorizontal: 4,
    flexDirection: 'row',
    gap: 12,
  },
  hint: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 13,
  },
  count: {
    color: c.textSecondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  address: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  addressWell: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  addressLabel: {
    color: c.textSecondary,
    fontSize: 13,
  },
  addressValue: {
    marginTop: 2,
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  save: {
    marginTop: 24,
  },
}));
