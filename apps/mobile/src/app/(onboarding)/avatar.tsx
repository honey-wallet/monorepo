// NOT IN THE FLOW FOR NOW: verify goes straight to the wallet (see lib/onboarding.ts).
// Kept as is so it can come back; nothing links here.
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar, randomAvatarSeed } from '@/components/Avatar';
import { Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { ShuffleIcon } from '@/components/onboarding/icons';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen, useStepStyles } from '@/components/onboarding/StepScreen';
import { setProfile } from '@/lib/profile';
import { makeStyles, useTheme } from '@/theme';

const SIZE = 148;

export default function AvatarScreen() {
  const { name = '' } = useLocalSearchParams<{ name?: string }>();
  const [seed, setSeed] = useState(randomAvatarSeed);
  const [photo, setPhoto] = useState<string | null>(null);
  const styles = useStyles();
  const stepStyles = useStepStyles();
  const c = useTheme();

  const shuffle = () => {
    setPhoto(null);
    setSeed(randomAvatarSeed());
  };

  const choosePhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled) setPhoto(result.assets[0].uri);
  };

  const finish = () => {
    setProfile({ name: name.trim() || 'Honey', photo, avatarSeed: seed });
    router.dismissAll();
    router.replace('/home');
  };

  return (
    <StepScreen
      title="Add a profile picture"
      footer={
        <View style={stepStyles.footerRow}>
          <PillButton
            variant="secondary"
            label={photo ? 'Change Photo' : 'Choose Photo'}
            onPress={choosePhoto}
            style={stepStyles.footerButton}
          />
          <PillButton label="Continue" onPress={finish} style={stepStyles.footerButton} />
        </View>
      }
    >
      <Text style={[stepStyles.hint, styles.hint]}>
        We picked one for you. Shuffle it, or choose a photo from your library.
      </Text>

      <View style={styles.stage}>
        <View>
          <View style={styles.ring}>
            <Swap id={photo ?? seed} size={SIZE}>
              <Avatar name={name} size={SIZE} uri={photo} seed={seed} />
            </Swap>
          </View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Shuffle avatar"
            hitSlop={8}
            onPress={shuffle}
            scaleTo={0.97}
            style={styles.shuffle}
          >
            <ShuffleIcon color={c.onPrimary} />
          </PressableScale>
        </View>
        <Text style={styles.name}>{name}</Text>
      </View>
    </StepScreen>
  );
}

const useStyles = makeStyles((c) => ({
  hint: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0,
  },
  stage: {
    marginTop: 40,
    alignItems: 'center',
  },
  ring: {
    padding: 6,
    borderRadius: SIZE / 2 + 6,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.divider,
  },
  shuffle: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
    borderWidth: 3,
    borderColor: c.canvas,
  },
  name: {
    marginTop: 16,
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
  },
}));
