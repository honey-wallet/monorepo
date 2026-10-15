import { Avatar as DiceBearAvatar, Style } from '@dicebear/core';
import dylan from '@dicebear/styles/dylan.json';
import { useMemo } from 'react';
import { Image, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

// "Dylan" by Natalia Spivak, CC BY 4.0 (credited in Settings > About).
const style = new Style(dylan);

/** A new random seed; each seed always draws the same face. */
export function randomAvatarSeed() {
  return Math.random().toString(36).slice(2, 10);
}

type Props = {
  name: string;
  size: number;
  /** A photo URI; when absent, the generated avatar for `seed` is shown. */
  uri?: string | null;
  seed: string;
};

export function Avatar({ name, size, uri, seed }: Props) {
  // react-native-svg can't parse DiceBear's RDF <metadata> block, and doesn't need it.
  const xml = useMemo(
    () => new DiceBearAvatar(style, { seed }).toString().replace(/<metadata>.*?<\/metadata>/s, ''),
    [seed],
  );

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel="Profile photo"
      />
    );
  }

  return (
    <View
      accessibilityLabel={`Avatar for ${name}`}
      style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}
    >
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}
