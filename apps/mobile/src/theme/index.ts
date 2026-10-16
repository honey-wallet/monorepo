import { StyleSheet, useColorScheme } from 'react-native';

/** Honey design tokens. Base values come from the brand palette. */
const light = {
  scheme: 'light' as 'light' | 'dark',
  // Pure white page with soft grey cards: the mirror of dark mode's ink and charcoal.
  canvas: '#FFFFFF', // Milk
  card: '#F5F5F5', // Cloud
  raised: '#EBEBEB', // Inset / hover
  // Sheets are white like the page; cards inside them are grey.
  sheet: '#FFFFFF',
  divider: '#E6E6E6',
  primary: '#F5C451', // Honey
  primaryTint: '#FFF1CB',
  text: '#242329',
  textSecondary: '#716E78',
  // True green and red for gains, losses and errors (no pink or mint).
  success: '#178548',
  error: '#D23B30',

  // Derived for components.
  onPrimary: '#242329',
  disabledText: '#B4A37A',
  placeholder: '#A9A6AE',
  highlight: '#8F6200',
  heroTop: '#FFEBB8',
  // Wallet: honey-tinted tiles and accent text, like Uniswap's pink surfaces.
  accentSurface: '#FFF3D1',
  accentText: '#8F6200',
  // A deep amber for the Honey Jar name and art: rich on white, warm on ink.
  honey: '#B5730A',
  // Segmented tabs: flat bar, lighter sliding pill.
  tabsBar: '#F0F0F0',
  tabsPill: '#FFFFFF',
  // Floating nav: lifted above page content with a shadow and hairline edge.
  navBar: '#FFFFFF',
  navPill: '#EFEFEF',
  navEdge: '#E6E6E6',
  navShadow: 0.12,

  // Logo artwork colours.
  brandYellow: '#FEBE2B',
  brandEyes: '#4B2817',
  brandWordmark: '#4B2817',
};

export type Palette = typeof light;

const dark: Palette = {
  scheme: 'dark',
  canvas: '#131313', // Ink
  card: '#1B1B1B', // Charcoal
  raised: '#262626', // Raised / hover
  sheet: '#1B1B1B',
  divider: '#2C2C2C',
  primary: '#F3C969', // Honey
  primaryTint: '#3B301C',
  text: '#F6F3EB',
  textSecondary: '#A3A3A3',
  success: '#3FD07E',
  error: '#FF665D',

  onPrimary: '#131313',
  disabledText: '#7D6B47',
  placeholder: '#5E5E5E',
  highlight: '#F3C969',
  heroTop: '#5C4722',
  accentSurface: '#29241B',
  accentText: '#F3C969',
  honey: '#F0B347',
  tabsBar: '#202020',
  tabsPill: '#3A3A3A',
  navBar: '#262626',
  navPill: '#3A3A3A',
  navEdge: '#333333',
  navShadow: 0.5,

  brandYellow: '#FEBE2B',
  brandEyes: '#131313',
  brandWordmark: '#F6F3EB',
};

/** Both palettes, for the rare surface that keeps one look whatever the theme (a share card). */
export const palettes: Record<'light' | 'dark', Palette> = { light, dark };

export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? palettes.dark : palettes.light;
}

/**
 * Builds a themed `StyleSheet` once per palette and returns a hook for it:
 *
 *   const useStyles = makeStyles((c) => ({ root: { backgroundColor: c.canvas } }));
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (c: Palette) => T) {
  const cache = new Map<Palette, T>();
  return function useStyles(): T {
    const c = useTheme();
    let styles = cache.get(c);
    if (!styles) {
      styles = StyleSheet.create(factory(c));
      cache.set(c, styles);
    }
    return styles;
  };
}
