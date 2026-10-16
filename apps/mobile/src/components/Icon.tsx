import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import Svg, { Circle, Path } from 'react-native-svg';

/** SF Symbols on iOS, Material Symbols on Android and web. */
const ICONS = {
  bell: { ios: 'bell', android: 'notifications', web: 'notifications' },
  scan: { ios: 'viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' },
  settings: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
  copy: { ios: 'square.on.square', android: 'content_copy', web: 'content_copy' },
  chevronRight: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  chevronLeft: { ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' },
  chevronDown: { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' },
  expand: { ios: 'chevron.up.chevron.down', android: 'unfold_more', web: 'unfold_more' },
  up: { ios: 'arrowtriangle.up.fill', android: 'arrow_drop_up', web: 'arrow_drop_up' },
  down: { ios: 'arrowtriangle.down.fill', android: 'arrow_drop_down', web: 'arrow_drop_down' },
  send: { ios: 'paperplane.fill', android: 'send', web: 'send' },
  receive: { ios: 'arrow.down.circle.fill', android: 'download', web: 'download' },
  buy: { ios: 'plus.circle.fill', android: 'add_circle', web: 'add_circle' },
  sell: { ios: 'minus.circle.fill', android: 'do_not_disturb_on', web: 'do_not_disturb_on' },
  home: { ios: 'house', android: 'home', web: 'home' },
  trade: { ios: 'arrow.left.arrow.right', android: 'swap_horiz', web: 'swap_horiz' },
  swapVertical: { ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' },
  arrowUp: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  arrowDown: { ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' },
  search: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  history: { ios: 'clock.arrow.circlepath', android: 'history', web: 'history' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  theme: { ios: 'circle.lefthalf.filled', android: 'contrast', web: 'contrast' },
  currency: { ios: 'banknote', android: 'payments', web: 'payments' },
  language: { ios: 'character.bubble', android: 'translate', web: 'translate' },
  chart: { ios: 'chart.bar.fill', android: 'bar_chart', web: 'bar_chart' },
  haptics: { ios: 'waveform.path', android: 'vibration', web: 'vibration' },
  advanced: { ios: 'slider.horizontal.3', android: 'tune', web: 'tune' },
  faceId: { ios: 'faceid', android: 'face', web: 'face' },
  recovery: { ios: 'doc.text.fill', android: 'description', web: 'description' },
  cloud: { ios: 'icloud.fill', android: 'cloud', web: 'cloud' },
  permissions: { ios: 'checkmark.shield', android: 'verified_user', web: 'verified_user' },
  help: { ios: 'questionmark.circle', android: 'help', web: 'help' },
  mail: { ios: 'envelope', android: 'mail', web: 'mail' },
  info: { ios: 'info.circle', android: 'info', web: 'info' },
  server: { ios: 'server.rack', android: 'dns', web: 'dns' },
  multisig: { ios: 'person.2.fill', android: 'group', web: 'group' },
  hardware: { ios: 'externaldrive.fill', android: 'usb', web: 'usb' },
  wallet: {
    ios: 'wallet.bifold.fill',
    android: 'account_balance_wallet',
    web: 'account_balance_wallet',
  },
  image: { ios: 'photo.on.rectangle', android: 'image', web: 'image' },
  pie: { ios: 'chart.pie.fill', android: 'pie_chart', web: 'pie_chart' },
  trendUp: { ios: 'chart.line.uptrend.xyaxis', android: 'trending_up', web: 'trending_up' },
  trendDown: { ios: 'chart.line.downtrend.xyaxis', android: 'trending_down', web: 'trending_down' },
  checkCircle: { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' },
  heart: { ios: 'heart', android: 'favorite_border', web: 'favorite_border' },
  heartFill: { ios: 'heart.fill', android: 'favorite', web: 'favorite' },
  flame: { ios: 'flame.fill', android: 'local_fire_department', web: 'local_fire_department' },
  shield: { ios: 'shield.fill', android: 'shield', web: 'shield' },
  leaf: { ios: 'leaf.fill', android: 'eco', web: 'eco' },
  bookmark: { ios: 'bookmark', android: 'bookmark_border', web: 'bookmark_border' },
  bookmarkFill: { ios: 'bookmark.fill', android: 'bookmark', web: 'bookmark' },
  more: { ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' },
  grid: { ios: 'square.grid.2x2.fill', android: 'grid_view', web: 'grid_view' },
  globe: { ios: 'globe', android: 'language', web: 'language' },
  link: { ios: 'arrow.up.right.square', android: 'open_in_new', web: 'open_in_new' },
  qr: { ios: 'qrcode', android: 'qr_code_2', web: 'qr_code_2' },
  photo: { ios: 'photo', android: 'photo', web: 'photo' },
  bank: { ios: 'building.columns.fill', android: 'account_balance', web: 'account_balance' },
  arrowUpCircle: {
    ios: 'arrow.up.circle.fill',
    android: 'arrow_circle_up',
    web: 'arrow_circle_up',
  },
  minusCircle: { ios: 'minus.circle.fill', android: 'remove_circle', web: 'remove_circle' },
  backspace: { ios: 'delete.left', android: 'backspace', web: 'backspace' },
  sparkles: { ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' },
  sun: { ios: 'sun.max.fill', android: 'light_mode', web: 'light_mode' },
  moon: { ios: 'moon.fill', android: 'dark_mode', web: 'dark_mode' },
  wrench: { ios: 'wrench.adjustable.fill', android: 'build', web: 'build' },
  gas: { ios: 'fuelpump.fill', android: 'local_gas_station', web: 'local_gas_station' },
  box: { ios: 'shippingbox.fill', android: 'inventory_2', web: 'inventory_2' },
  lock: { ios: 'lock.fill', android: 'lock', web: 'lock' },
  book: { ios: 'book.fill', android: 'menu_book', web: 'menu_book' },
  trash: { ios: 'trash', android: 'delete', web: 'delete' },
  warning: { ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' },
  pencil: { ios: 'pencil', android: 'edit', web: 'edit' },
  person: { ios: 'person.fill', android: 'person', web: 'person' },
  eye: { ios: 'eye', android: 'visibility', web: 'visibility' },
  eyeSlash: { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' },
  key: { ios: 'key.fill', android: 'key', web: 'key' },
  binoculars: { ios: 'binoculars.fill', android: 'visibility', web: 'visibility' },
  target: { ios: 'target', android: 'track_changes', web: 'track_changes' },
  chat: { ios: 'bubble.left.fill', android: 'chat', web: 'chat' },
  card: { ios: 'creditcard.fill', android: 'credit_card', web: 'credit_card' },
  clock: { ios: 'clock', android: 'schedule', web: 'schedule' },
  predict: { ios: 'chart.bar.xaxis', android: 'insights', web: 'insights' },
  layers: { ios: 'square.stack.3d.up.fill', android: 'layers', web: 'layers' },
  text: { ios: 'text.alignleft', android: 'notes', web: 'notes' },
  verified: { ios: 'checkmark.seal.fill', android: 'verified', web: 'verified' },
} satisfies Record<string, SymbolViewProps['name']>;

export type IconName = keyof typeof ICONS | 'piggyBank';

type Props = {
  name: IconName;
  size?: number;
  color: string;
};

export function Icon({ name, size = 22, color }: Props) {
  if (name === 'piggyBank') return <PiggyBankIcon size={size} color={color} />;
  if (name === 'trade') return <TradeIcon size={size} color={color} />;
  return <SymbolView name={ICONS[name]} size={size} tintColor={color} />;
}

/** Trade: two arrows chasing each other round a circle, drawn to match the outline icons. */
function TradeIcon({ size, color }: { size: number; color: string }) {
  const stroke = {
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Upper arc, arrowhead at the right */}
      <Path d="M2.7 9.2A9.7 9.7 0 0 1 19.5 5.9L17.2 7.3L22.1 9.6V4.1" {...stroke} />
      {/* Lower arc, arrowhead at the left */}
      <Path d="M21.3 14.8A9.7 9.7 0 0 1 4.5 18.1L6.8 16.7L1.9 14.4V19.9" {...stroke} />
    </Svg>
  );
}

/** SF Symbols has no piggy bank, so it's drawn here to match the outline icons. */
function PiggyBankIcon({ size, color }: { size: number; color: string }) {
  const stroke = {
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Body, snout and legs */}
      <Path
        d="M5.2 10.6C5.9 7.7 8.6 6 12 6c1.6 0 3 .3 4.1.9l2.4-1.4v3.1c.7.6 1.2 1.3 1.5 2.1h1.2v3.6h-1.4c-.4.9-1 1.6-1.8 2.2V19h-2.6v-1.6c-.7.2-1.5.3-2.4.3s-1.7-.1-2.4-.3V19H8v-2.6c-1.7-1.1-2.8-2.8-2.8-4.6 0-.4 0-.8 0-1.2Z"
        {...stroke}
      />
      {/* Tail */}
      <Path d="M5.3 10.9c-1.2 0-2.1-.7-2.1-1.8" {...stroke} />
      {/* Coin slot */}
      <Path d="M10 8.9h3.4" {...stroke} />
      <Circle cx={16.4} cy={11.2} r={1} fill={color} />
    </Svg>
  );
}
