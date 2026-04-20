/**
 * Inline <script> in <head> that applies the user's saved theme before
 * first paint. Avoids the flash-of-light-then-dark (FOLTD) for users who
 * have saved dark mode.
 *
 * Kept deliberately tiny — this runs synchronously before hydration.
 */
const THEME_INIT_SCRIPT = `(function(){try{var k='ledger-theme';var s=localStorage.getItem(k);var m=s==='dark'||s==='light'?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(m==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`;

export function ThemeInit() {
  return (
    <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
  );
}
