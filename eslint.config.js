// ESLint, flat config. `npm run lint` runs it and CI runs the same command in the guards job.
//
// The linter is here for correctness, not for looks: there is no formatting rule and no Prettier. The code style
// (no semicolons, single quotes, two spaces, long lines) is kept by the people and the agents who write it.
//
// What it checks: `@eslint/js` recommended for every file (unused variables and imports, undefined names, unreachable
// code, and the like), and the React hooks rules for the app in `src/`. The globals of each folder say where the code
// runs (browser, Node, or both), so that a browser name used in server code is an error.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

// The names that Node and the browser both define (console, setTimeout, URL, fetch, ...).
const inBoth = Object.fromEntries(Object.entries(globals.node).filter(([name]) => name in globals.browser))

export default defineConfig([
  globalIgnores([
    'dist/', // the build output
    'dev-dist/', // the output of the PWA plugin in development
    'test-results/', // Playwright: traces and screenshots
    'playwright-report/',
    'blob-report/',
    '**/node_modules/',
  ]),

  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      // Every package.json in the repository is "type": "module", so every file is an ES module.
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: {
      // An `eslint-disable` comment that switches off nothing is a leftover: report it, so that a disable comment never
      // outlives the code it was written for.
      reportUnusedDisableDirectives: 'error',
    },
  },

  // The app runs in the browser.
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: { globals: globals.browser },
  },

  // The two classic React hooks rules, for the app only (the only place that has components and hooks).
  //
  // Not the whole `recommended` preset of eslint-plugin-react-hooks 7: it adds the rules of the React Compiler (`refs`,
  // `set-state-in-effect`, `immutability`, `purity`, ...). This app does not use the compiler, and it uses on purpose
  // what those rules forbid: the "latest value" ref that is assigned while rendering, and the effect that calls a
  // `load()` function which sets state. Rewriting that is a refactor of its own, not a lint rule to switch on.
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // Code that runs on the server, in a script or in the tooling.
  {
    files: [
      'api/**/*.js',
      'server/**/*.{js,mjs}',
      'scripts/**/*.mjs',
      '*.config.js', // vite, vitest, playwright and this file
    ],
    languageOptions: { globals: globals.node },
  },

  // Code that is imported by the browser and by the server alike: only the names that both of them have (`window` or
  // `process` here would break one of the two).
  {
    files: ['shared/**/*.js'],
    languageOptions: { globals: inBoth },
  },

  // Vitest tests run in Node. Vitest is configured without globals (vitest.config.js), so every test imports `describe`,
  // `it` and `expect`. The component tests run in jsdom, which gives them the browser's names too.
  {
    files: ['tests/**/*.{js,jsx}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/components/**/*.{js,jsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // Playwright specs run in Node, but the functions that they pass to `page.evaluate` run in the page.
  {
    files: ['e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // The kill switch of the old app's service worker, a separate deployable (legacy-redirect/, on Firebase Hosting).
  {
    files: ['legacy-redirect/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
])
