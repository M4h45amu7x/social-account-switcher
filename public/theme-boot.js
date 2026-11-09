// Runs before the stylesheet, so the popup never flashes the wrong colours.
// It must be a classic, synchronous script: chrome.storage is async, and MV3 forbids inline scripts.
// "theme" is a cache of settings.theme written by src/popup/theme.ts. System means no attribute.
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark')
    document.documentElement.setAttribute('data-theme', theme);
} catch {
  // storage blocked: fall back to System
}
