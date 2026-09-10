import { defineConfig } from '@playwright/test';

// The fixture runs from a loopback origin on purpose: SillyTavern is always
// served from localhost/127.0.0.1, which is a secure context. A non-loopback
// test origin would hide real behaviour (`crypto.randomUUID`, clipboard) behind
// insecure-context failures that never happen in production. No server is
// needed: every request is intercepted by the test's own route handlers.
export default defineConfig({
    testDir: '.',
    testMatch: 'NpcPortraitPreview.e2e.js',
    workers: 1,
    use: {
        baseURL: 'http://127.0.0.1:8000',
        browserName: 'chromium',
        serviceWorkers: 'block',
        viewport: { width: 1280, height: 800 },
    },
});
