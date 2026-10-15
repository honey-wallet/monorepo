import { useState } from 'react';
import { View } from 'react-native';
import type { IconName } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { NotificationBadge } from '@/components/motion/NotificationBadge';
import { PressableScale } from '@/components/motion/PressableScale';
import { Tooltip } from '@/components/motion/Tooltip';
import { tap } from '@/lib/haptics';
import { useTheme } from '@/theme';

/**
 * A bare icon in Home's header (no circle). Long-press names it in a tooltip, and
 * `badge` pins an unread dot to its corner.
 */
export function HeaderShortcut({
  icon,
  label,
  onPress,
  badge = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  badge?: boolean;
}) {
  const c = useTheme();
  const [hinting, setHinting] = useState(false);
  return (
    <View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={badge ? `${label}, new` : label}
        hitSlop={10}
        scaleTo={0.97}
        delayLongPress={350}
        onPress={() => {
          tap();
          onPress();
        }}
        onLongPress={() => {
          tap();
          setHinting(true);
        }}
        onPressOut={() => setHinting(false)}
      >
        <IconSwap name={icon} size={23} color={c.textSecondary} />
        {badge && <NotificationBadge />}
      </PressableScale>
      <Tooltip label={label} visible={hinting} />
    </View>
  );
}
