import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.clauderemote.dev',
  appName: 'Claude Remote Dev',
  webDir: 'bootstrap',
  server: {
    cleartext: true,  // Allow HTTP (needed for local network / Tailscale)
    allowNavigation: ['*'],  // Allow WebView to navigate to server URLs
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon',
      iconColor: '#a080f0',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b0c10',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
  android: {
    allowMixedContent: true,  // Allow WS connections over HTTP
    backgroundColor: '#0b0c10',
  },
};

export default config;
