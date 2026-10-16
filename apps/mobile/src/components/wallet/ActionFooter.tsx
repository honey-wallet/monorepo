import { Text } from 'react-native';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';

const BUTTON_HEIGHT = 54;

/** Footer height above the safe area, for positioning a menu that opens above it. */
export const ACTION_FOOTER_HEIGHT = SCREEN.footerTop + BUTTON_HEIGHT + SCREEN.footerBottom;

/**
 * `primary` honey (Buy), `secondary` grey (Sell; honey tint reads as disabled), `up` green tint (Long),
 * `down` red tint (Short).
 */
export type FooterTone = 'primary' | 'secondary' | 'up' | 'down';

export type FooterAction = {
  label: string;
  tone: FooterTone;
  onPress: () => void;
  accessibilityLabel?: string;
};

/**
 * Two big actions at the bottom of a detail page (Buy/Sell on a token, Long/Short on
 * a perp), plus an optional grid button that opens more actions and swaps to ✕.
 * Pass it as a `PushedScreen` footer, which lays its children out in a row.
 */
export function ActionFooter({
  actions,
  menu,
}: {
  actions: [FooterAction, FooterAction];
  menu?: { open: boolean; onToggle: () => void };
}) {
  const styles = useStyles();
  const c = useTheme();
  const tones: Record<FooterTone, { background: string; color: string }> = {
    primary: { background: c.primary, color: c.onPrimary },
    secondary: { background: c.raised, color: c.text },
    up: { background: `${c.success}26`, color: c.success },
    down: { background: `${c.error}26`, color: c.error },
  };
  return (
    <>
      {actions.map((action) => {
        const tone = tones[action.tone];
        return (
          <PressableScale
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel}
            onPress={() => {
              tap();
              action.onPress();
            }}
            style={[styles.button, { backgroundColor: tone.background }]}
          >
            <Text style={[styles.label, { color: tone.color }]}>{action.label}</Text>
          </PressableScale>
        );
      })}
      {menu && (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={menu.open ? 'Close actions' : 'More actions'}
          accessibilityState={{ expanded: menu.open }}
          onPress={() => {
            tap();
            menu.onToggle();
          }}
          style={[styles.square, menu.open && styles.squareOpen]}
        >
          <IconSwap
            name={menu.open ? 'close' : 'grid'}
            size={menu.open ? 20 : 18}
            color={menu.open ? c.accentText : c.textSecondary}
          />
        </PressableScale>
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  button: {
    flex: 1,
    height: BUTTON_HEIGHT,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 17,
    fontWeight: '600',
  },
  square: {
    width: BUTTON_HEIGHT,
    height: BUTTON_HEIGHT,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  squareOpen: {
    borderWidth: 1,
    borderColor: c.divider,
    backgroundColor: c.canvas,
  },
}));
