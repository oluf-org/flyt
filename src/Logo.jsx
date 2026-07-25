// The wordmark lockups (D29). Two arrangements of one mark: horizontal for the
// title bar, stacked for the places that introduce the app rather than just
// label it (the About panel, the Lander's section label).
//
// The mark itself lives in logo.js as an SVG string — same convention as
// sigil(), same `currentColor`-only rule, so both lockups inherit whatever
// colour their context sets and neither needs a light/dark variant.
//
// Type is Figtree 700 at −4% tracking (styles.css `.wordmark`), already loaded
// by index.html: the wordmark speaks in the app's existing voice rather than
// importing a second one.
import { logoMark } from './logo.js';
import { APP_NAME } from '../core/brand.js';

export function LogoMark({ size = 18, title = null, className = 'logo-mark' }) {
  return (
    <span
      className="logo-mark-wrap"
      dangerouslySetInnerHTML={{ __html: logoMark(size, { title, className }) }}
    />
  );
}

// `stacked` puts the mark above the word; the default sits them side by side.
// `markSize` follows the type size — the lockup is one object, not two.
export default function Logo({ stacked = false, markSize = 18, className = '' }) {
  return (
    <span className={`lockup${stacked ? ' lockup-stacked' : ''}${className ? ` ${className}` : ''}`}>
      <LogoMark size={markSize} title={APP_NAME} />
      <span className="wordmark">{APP_NAME}</span>
    </span>
  );
}
