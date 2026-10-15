import { Icon, type IconName } from '@/components/Icon';
import { HEADER_BUTTON } from '@/components/wallet/parts';
import { useTheme } from '@/theme';
import { MenuDropdown } from './MenuDropdown';

export type Action = { label: string; icon: IconName; onPress: () => void };

/**
 * A standard round header button (••• by default) that opens a list of actions,
 * using the same transitions.dev "Menu dropdown" motion as the sort menu.
 */
export function ActionMenu({
  actions,
  icon = 'more',
  size = 18,
}: {
  actions: Action[];
  icon?: IconName;
  size?: number;
}) {
  const c = useTheme();
  return (
    <MenuDropdown
      options={actions.map((a) => ({ value: a.label, label: a.label, icon: a.icon }))}
      value=""
      onChange={(label) => actions.find((a) => a.label === label)?.onPress()}
      triggerStyle={{
        width: HEADER_BUTTON,
        height: HEADER_BUTTON,
        borderRadius: HEADER_BUTTON / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.raised,
      }}
      trigger={() => <Icon name={icon} size={size} color={c.text} />}
    />
  );
}
