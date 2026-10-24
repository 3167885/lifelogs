import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lifelogs.sleep',
  appName: 'Sleep Tracker',
  webDir: 'dist',
  server: {
    // https scheme → WebView origin is https://localhost, which is in the
    // backend CORS allowlist (阶段 1). cleartext is enabled ONLY because the
    // local dev backend is plain http on 10.0.2.2:8787; this is a dev/test
    // configuration, not a release posture.
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    // DEV/TEST ONLY (阶段 2 本地联调): the page origin is https://localhost
    // while the local backend is plain http://10.0.2.2:8787. Android's
    // `cleartext` alone does NOT lift WebView page-level Mixed Content
    // blocking; Chromium blocks https-page → http-resource requests.
    // allowMixedContent is required for THIS local pairing only. A release
    // build must point at an https backend and remove both flags — tracked
    // as a 阶段 4 item; do not treat this as a production posture.
    allowMixedContent: true,
  },
};

export default config;
