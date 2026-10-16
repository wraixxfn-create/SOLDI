import { defineConfig } from 'vite';

/**
 * WORLDBUG build/dev configuration.
 *
 * Design notes:
 * - `base: './'` so the built bundle can be dropped into any HTML5 portal
 *   sub-directory (itch.io, portal CDNs, static hosting) without path rewrites.
 * - Dev server binds 0.0.0.0 and accepts any forwarded host so the game can be
 *   previewed through container/port-forwarding environments (see docs/DECISIONS.md ADR-004).
 * - No runtime dependencies are bundled: the output is plain HTML + JS + CSS.
 */
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
  },
});
