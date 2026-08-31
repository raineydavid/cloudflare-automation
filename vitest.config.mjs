// Mirrors the exclusions the source repo carried (ontold vite.config.ts):
// workers/wallet-signer has its OWN package.json (viem) installed only
// inside that directory, so its tests cannot resolve from the root —
// they run in deploy-wallet-signer.yml after that install instead.
// workers/site-host stays in this suite: its helpers are dependency-free
// by design.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'workers/wallet-signer/**'],
  },
});
