/**
 * The house look, shared by every page this Worker serves itself.
 *
 * The front door was built in the app's palette after the founder's
 * *"the default ontold.site doesn't follow our branding guidelines and
 * colours or logo etc — looks totally detached"*. The 404 was not, and
 * nobody noticed for a month because a 404 is the one page you only see
 * by accident: generic #111 on #eee with a coral link, no mark, no
 * address bar, no relation to the site the visitor had just been
 * looking at.
 *
 * Tokens lifted verbatim from src/index.css's @theme; the mark is
 * public/icon.svg. Red is spent the way the app spends it — the mark,
 * the address, the lock, the primary action, nothing else.
 *
 * Standing constraint, inherited: no external CSS, fonts, scripts or
 * images. The Worker returns one string and nothing else loads, which
 * is why the inline SVGs carry no xmlns.
 */

/** Tokens and the elements both pages share. Page-specific rules are
 *  appended by the page. */
export const BRAND_CSS = `
  :root{
    --dark:#070707;       /* --color-brand-dark */
    --gray:#1a1a1a;       /* --color-brand-gray */
    --bone:#F5F1E8;       /* --color-brand-bone */
    --red:#DC2626;        /* --color-brand-red */
    --muted:rgba(245,241,232,.55);
    --rule:rgba(245,241,232,.10);
  }
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{
    background:
      radial-gradient(90% 60% at 50% -10%, rgba(220,38,38,.16) 0%, transparent 62%),
      var(--dark);
    color:var(--bone);
    font:16px/1.6 'Inter',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:grid; place-items:center; padding:6vh 5vw;
    -webkit-font-smoothing:antialiased;
  }
  main{width:100%;max-width:760px;text-align:center}
  .mark{display:inline-block;width:34px;height:auto;margin:0 0 1.5rem;
    filter:drop-shadow(0 0 14px rgba(220,38,38,.45))}
  .eyebrow{
    font:700 11px/1 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    letter-spacing:.22em; text-transform:uppercase; color:var(--muted);
    margin:0 0 2.75rem;
  }
  .bar{
    display:flex; align-items:center; gap:.9rem;
    background:var(--gray);
    border:1px solid var(--rule); border-radius:999px;
    padding:1.15rem 1.75rem; margin:0 auto 3rem; max-width:640px;
    text-align:left; box-shadow:0 18px 50px -30px #000;
  }
  .lock{flex:0 0 20px;width:20px;height:20px;color:var(--muted);transition:color .25s}
  .lock.secure{color:var(--red)}
  .lock .shackle{
    transform-origin:9px 9px; transform:translateY(-2.5px);
    transition:transform .32s cubic-bezier(.2,1.6,.4,1);
  }
  .lock.secure .shackle{transform:translateY(0)}
  .addr{
    font:500 clamp(17px,4.1vw,29px)/1 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    letter-spacing:-.02em; white-space:nowrap; overflow:hidden;
  }
  .slug{color:var(--red)}
  .rest{color:var(--bone)}
  h1{
    font:700 clamp(26px,5.1vw,42px)/1.08 'Inter',system-ui,-apple-system,sans-serif;
    letter-spacing:-.03em; margin:0 0 1rem; text-wrap:balance;
  }
  h1 em{font-family:'Instrument Serif',Georgia,"Times New Roman",serif;
    font-style:italic; font-weight:400; letter-spacing:-.01em}
  .lede{
    color:var(--muted); font-size:clamp(15px,2.4vw,18px);
    max-width:46ch; margin:0 auto 2.5rem; text-wrap:pretty;
  }
  .cta{
    display:inline-block; background:var(--red); color:#fff;
    font-weight:700; text-decoration:none; padding:.85rem 1.9rem;
    border-radius:999px; letter-spacing:-.01em;
    box-shadow:0 8px 24px -6px rgba(220,38,38,.55);
    transition:transform .18s, box-shadow .18s, background .18s;
  }
  .cta:hover{transform:translateY(-2px); background:#EF4444;
    box-shadow:0 14px 32px -10px rgba(220,38,38,.7)}
  .cta:focus-visible{outline:3px solid var(--bone); outline-offset:3px}
  footer{
    margin-top:3.5rem; padding-top:1.5rem; border-top:1px solid var(--rule);
    color:var(--muted); font-size:13px; text-align:center;
  }
  footer a{color:var(--bone)}
  @media (prefers-reduced-motion:reduce){
    .cta{transition:none}
    .lock .shackle{transition:none}
  }`;

/** The mark from public/icon.svg — red play-D, white triangle. */
export const MARK_SVG = `<svg class="mark" viewBox="15 10 63 60" fill="none" aria-hidden="true">
    <g transform="translate(15,10) scale(1.5)">
      <path d="M0 0H20C32 0 42 10 42 20C42 30 32 40 20 40H0V0Z" fill="#DC2626"/>
      <path d="M16 11L29 20L16 29Z" fill="#fff"/>
    </g>
  </svg>`;

/** The padlock. Closed means the name exists and TLS is valid; open
 *  means the name is free — which is the whole message of a 404 here. */
export function lockSvg(secure) {
  return `<svg class="lock${secure ? ' secure' : ''}" id="lock" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path class="shackle" d="M5.5 8V5.5a3.5 3.5 0 1 1 7 0V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <rect x="3.5" y="8" width="11" height="7.5" rx="2" fill="currentColor"/>
    </svg>`;
}

/** HTML-escape. Applied at the point of interpolation rather than
 *  trusted to the caller: depending on a caller's validation is how the
 *  second caller introduces the bug. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
