import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
// Imported next to this file (not read from the working directory): tests/app-build.test.js loads this config from anywhere.
import vercel from './vercel.json' with { type: 'json' }

// The headers that Vercel puts on every page and file (the rule "/(.*)" of vercel.json, whatever else is there), as the
// object that Vite wants: { name: value }. `vite preview` sends them below, so the E2E tests, which run on the preview of the
// production build, run the app under the same headers as production (the Content-Security-Policy among them), and a page
// that breaks the policy fails its test. The "/assets/(.*)" rule is not copied: it is a cache rule, and the preview sets its own cache headers.
// tests/app-build.test.js pins that the two cannot drift.
const everyPageRule = vercel.headers.find((rule) => rule.source === '/(.*)')
if (!everyPageRule) throw new Error('vercel.json has no headers rule for "/(.*)": vite preview would send none of the production headers.')
const productionHeaders = Object.fromEntries(everyPageRule.headers.map(({ key, value }) => [key, value]))

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
        // Every phone downloads the precache when the app is installed and again with each new version, so it holds only
        // what the app shows. Heebo's "math" and "symbols" subsets (about 38 KB) cover characters that no screen needs to
        // work offline: the browser still downloads one of them by itself if a page ever shows such a character (the
        // arrow of the audit log, which needs the network anyway). The other subsets (Hebrew, Latin, Latin Extended) stay.
        globIgnores: ['**/heebo-math-*', '**/heebo-symbols-*'],
        // API calls and CSV downloads must never be answered with the app shell.
        navigateFallbackDenylist: [/^\/api\//],
        // No runtime caching: the map's tiles are cross-origin images without CORS (opaque answers), which a CacheFirst
        // rule never stores, so a rule for them only routed every tile through the service worker for nothing; Leaflet
        // and its marker pictures come with the app.
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
  // Only `preview`, never `server`: the dev server injects an inline script and style tags of its own (the React refresh
  // preamble, the HMR client, a style element per CSS file), which the Content-Security-Policy would refuse. The preview
  // serves the built files, as they are in production. Vite sends these on every file and on index.html (which it
  // serves for every path that is not a file); the answers of the API proxy do not get them here, and the tests need only
  // the headers of pages and files.
  preview: { headers: productionHeaders },
})
