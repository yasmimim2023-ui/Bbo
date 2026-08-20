import type { CapacitorConfig } from '@capacitor/cli';

/**
 * IRONBOX 1.0 — Capacitor configuration.
 *
 * The assistant's display name lives in www/js/config.js; this file only
 * carries values Android itself needs at build time.
 */
const config: CapacitorConfig = {
  appId: 'com.ironbox.virtualassistant',
  appName: 'IRONBOX 1.0',
  webDir: 'www',
  android: {
    allowMixedContent: false,
    // Videos are streamed from app-specific external storage through
    // Capacitor's local web server, which needs range-request support.
    captureInput: false,
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: false,
    },
  },
};

export default config;
