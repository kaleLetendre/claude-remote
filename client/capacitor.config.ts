import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.clauderemote.app',
  appName: 'Claude Remote',
  webDir: 'www',
  server: {
    // For development: point to your server's LAN address
    // Comment this out for production builds (will use bundled www/)
    // url: 'http://192.168.1.42:3033',
    cleartext: true,  // Allow HTTP (needed for local network)
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
