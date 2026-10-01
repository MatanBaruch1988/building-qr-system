import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
  server: {
    port: 3000,
    // `npm run dev:api` serves the same handler as production on this port (API_PORT overrides it; the E2E tests
    // use that to run their own API next to a development one). `vite preview` reuses this proxy.
    // xfwd: pass the browser's real host along, so the API's same-origin check sees the page's own host.
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT || 3001}`, xfwd: true } },
  },
})
