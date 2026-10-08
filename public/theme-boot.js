// Light / dark, applied before the first paint so there is no flash of the wrong one. Same logic as src/ui/theme.js (the
// key, the three values): tests/theme.test.js keeps them in step.
//
// It is a file of its own, and not an inline script in index.html, because the Content-Security-Policy of vercel.json
// allows no inline script (AGENTS.md, "Rules for every change"). index.html loads it with a plain classic script tag (no
// async, no defer, no type), so it still blocks the parser and runs before the first paint, ahead of the module script.
// Vite copies a file of public/ as it is: this one is not bundled or compiled, so it stays plain JavaScript that every
// phone of build.target (vite.config.js) can run: no syntax newer than that floor (the optional catch binding is older).
(function () {
  var choice = 'system';
  try { var saved = localStorage.getItem('qr.theme'); if (saved === 'light' || saved === 'dark') choice = saved; } catch { /* storage is blocked: follow the device */ }
  var light = choice === 'light' || (choice === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  var theme = light ? 'light' : 'dark';
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  var chrome = document.querySelector('meta[name="theme-color"]');
  if (chrome) chrome.setAttribute('content', light ? '#f4f5f7' : '#0b0b0d');
})();
