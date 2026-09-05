/** Native chrome, matching the Slate & Sage --app token in styles.css. */
export const STOCK_WINDOW_CHROME = Object.freeze({
  light: Object.freeze({ color: '#1f2724', symbolColor: '#e6ebe8', height: 40 }),
  dark: Object.freeze({ color: '#0f1512', symbolColor: '#dfe7e2', height: 40 }),
});

/**
 * Native overlay colors follow only the app theme. `projectColor` remains in
 * the signature for preload/main-process compatibility, but project identity
 * is intentionally confined to the renderer's tabs and lander accents.
 */
export function projectWindowChrome(mode = 'light', _projectColor = null) {
  const half = mode === 'dark' ? 'dark' : 'light';
  return { ...STOCK_WINDOW_CHROME[half] };
}
