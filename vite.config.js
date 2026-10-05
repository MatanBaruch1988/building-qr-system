import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The build id of this bundle: the first 7 characters of the commit that Vercel builds (VERCEL_GIT_COMMIT_SHA, the same 7
// characters that server/health.js reports as the server's own commit), or 'dev' for a build that has none (a local build and
// the E2E tests). It is written into the JavaScript below, and src/ui/build.js reads it. Installed phones keep running old
// JavaScript for days or weeks, so this is how the committee tells which version a phone has. APP_BUILD_RE in
// shared/contract.js is its shape.
const appBuild = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev'

export default defineConfig({
  // `define` is applied by `vite build` and by `vite dev` alike. Vitest reads vitest.config.js, not this file, so in a unit
  // test the value is missing and src/ui/build.js answers 'dev'.
  define: { 'import.meta.env.VITE_APP_BUILD': JSON.stringify(appBuild) },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new version waits for the next app start instead of reloading the page in the
      // middle of a check-in (the old 'autoUpdate' could do that).
      registerType: 'prompt',
      // The SVG is the favicon and the source of the PNGs (npm run icons); the PNGs are what iOS and the manifest use.
      includeAssets: ['pwa-192x192.svg', 'pwa-512x512.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'נוכחות בבניין',
        short_name: 'נוכחות',
        description: 'רישום נוכחות נותני שירות בבניין באמצעות QR',
        theme_color: '#0b0b0d',
        background_color: '#0b0b0d',
        display: 'standalone',
        dir: 'rtl',
        lang: 'he',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        // API calls and CSV downloads must never be answered with the app shell.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/unpkg\.com\/leaflet/,
            handler: 'CacheFirst',
            options: { cacheName: 'leaflet-cdn', expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          {
            urlPattern: /^https:\/\/.*tile\.openstreetmap\.org/,
            handler: 'CacheFirst',
            options: { cacheName: 'map-tiles', expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 } },
          },
        ],
      },
    }),
  ],
  build: {
    // Vite 7 raised its default target to 'baseline-widely-available' and Vite 8 moved it again (Chrome 111, Firefox 114,
    // Safari 16.4). The service providers' phones are not known, so the target stays what Vite 5 built for ('modules':
    // Chrome 87, Firefox 78, Safari 14). Raising this floor is a separate decision of the owner, not a side effect of a
    // Vite upgrade. It sets the syntax level of the JavaScript (Oxc) and of the CSS (Lightning CSS).
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rolldownOptions: {
      // Vite strips license comments from the bundle when it minifies (Vite 5 kept them). React, its scheduler and Leaflet
      // ask for their notice to ship with the code, so keep those comments, as before.
      output: { comments: { legal: true } },
    },
  },
  server: {
    port: 3000,
    // `npm run dev:api` serves the same handler as production on this port (API_PORT overrides it; the E2E tests
    // use that to run their own API next to a development one). `vite preview` reuses this proxy.
    // xfwd: pass the browser's real host along, so the API's same-origin check sees the page's own host.
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT || 3001}`, xfwd: true } },
  },
})
