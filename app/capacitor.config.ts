import type { CapacitorConfig } from '@capacitor/cli';

const devHttpEnabled = process.env.CAPACITOR_DEV_HTTP === '1';

const config: CapacitorConfig = {
  appId: 'com.lifelogs.sleep',
  appName: 'Sleep Tracker',
  webDir: 'dist',
  // Keep bridge logs off in every build; request bodies and headers can contain
  // credentials even when the app itself never logs them.
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
    cleartext: devHttpEnabled,
  },
  android: {
    // Only the explicit local-emulator opt-in may permit HTTPS page → HTTP API.
    // A normal production Cap sync leaves both this and cleartext disabled.
    allowMixedContent: devHttpEnabled,
  },
};

export default config;
