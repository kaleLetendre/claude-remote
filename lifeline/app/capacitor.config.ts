import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.clauderemote.lifeline',
  appName: 'CR Lifeline',
  webDir: 'bootstrap',
  server: {
    cleartext: true,
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#0d0e14',
  },
};

export default config;
