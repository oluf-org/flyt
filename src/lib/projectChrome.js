import { normalizeHexColor } from './projectTheme.js';

/** Stock native chrome, matching the projectless --app token in styles.css. */
export const STOCK_WINDOW_CHROME = Object.freeze({
  light: Object.freeze({ color: '#1f2724', symbolColor: '#e6ebe8', height: 40 }),
  dark: Object.freeze({ color: '#0f1512', symbolColor: '#dfe7e2', height: 40 }),
});

/* Neutral base used by the project-scoped --app token. Native Windows title
   bar controls do not inherit CSS, so the main process repeats the same 10%
   sRGB mix used by project-theme.css. */
const PROJECT_APP_BASE = Object.freeze({ light: '#242424', dark: '#141414' });
const PROJECT_SYMBOL = '#f3f3f3';
const PROJECT_MIX = 0.1;

function mixHex(foreground, background, weight) {
  const channel = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16);
  const values = [1, 3, 5].map((offset) =>
    Math.round(channel(foreground, offset) * weight + channel(background, offset) * (1 - weight)));
  return `#${values.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Native overlay colors for a theme mode and optional active project color. */
export function projectWindowChrome(mode = 'light', projectColor = null) {
  const half = mode === 'dark' ? 'dark' : 'light';
  const hex = normalizeHexColor(projectColor);
  if (!hex) return { ...STOCK_WINDOW_CHROME[half] };
  return {
    color: mixHex(hex, PROJECT_APP_BASE[half], PROJECT_MIX),
    symbolColor: PROJECT_SYMBOL,
    height: 40,
  };
}
