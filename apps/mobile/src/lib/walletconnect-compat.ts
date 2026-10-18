// WalletConnect's polyfills (crypto.getRandomValues, TextEncoder, URL…) must load before
// anything else; app/_layout.tsx imports this first. The browser has them (see .web.ts).
import '@walletconnect/react-native-compat';
