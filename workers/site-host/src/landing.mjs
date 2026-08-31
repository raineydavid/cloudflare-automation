/**
 * ontold.site — the front door.
 *
 * Why this exists (founder, 2026-07-25): "should we have a default
 * beautiful landing page for ontold.site so people create their sites
 * on ontold.com?" Yes — it catches the highest-intent visitor there is.
 * Someone sees a real published site at <slug>.ontold.site, deletes the
 * subdomain out of curiosity, and hits Enter. Before this, the apex had
 * no DNS at all and www got a plain-text "not found". That visitor has
 * already seen the product work; the only job of this page is to send
 * them to ontold.com to make one.
 *
 * ## The palette is the app's, not its own (founder, 2026-07-31)
 *
 * The first version chose deep indigo and amber, on the reasoning that
 * a front door is closer to a poster than an app surface and should
 * avoid the looks that read as generic. That reasoning was fine and the
 * conclusion was wrong: *"the default ontold.site doesn't follow our
 * branding guidelines and colours or logo etc - looks totally
 * detached"*. A door that doesn't look like the building is a worse
 * door however good the poster is, because the one thing this page must
 * do is convince a visitor that the site they just saw and the studio
 * they're being sent to are the same company.
 *
 * So the tokens are lifted verbatim from src/index.css's @theme, and
 * the mark is the one in public/icon.svg:
 *
 *   --color-brand-dark  #070707   the field
 *   --color-brand-red   #DC2626   the signal, and the logo's play-D
 *   --color-brand-bone  #F5F1E8   body copy (warm, not pure white)
 *   --color-brand-gray  #1a1a1a   raised surfaces
 *
 * Red is spent the way the app spends it: the mark, the live slug, the
 * lock, and the primary action. Nothing else.
 *
 * Type has to diverge, and this is the one honest exception. The app
 * loads Inter and Instrument Serif from Google Fonts; this page cannot
 * load anything (see below), so it uses the system stack plus a system
 * serif italic for the editorial accent — which is exactly the fallback
 * chain the app's own --font-serif token declares.
 *
 * ## The examples strip (same founder note: "no examples in homepage")
 *
 * Shows what you type next to the address it produces, because that
 * pairing IS the pitch and the headline already promises it. Sentences
 * rather than screenshots for two reasons: a screenshot would be an
 * external image request this page is not allowed to make, and any
 * image of "a real site" invites the reading that these are customers.
 * They are labelled as examples and the page claims no usage numbers.
 *
 * ## Signature element
 *
 * The hero is an ADDRESS BAR. Every visitor arrived via one; the URL is
 * the product demo. It types a slug, then the padlock snaps shut —
 * dramatising the actual technical property this platform has and
 * GitHub Pages does not: a wildcard certificate makes any new name
 * valid over HTTPS the instant it exists, with no provisioning wait.
 *
 * ## Standing constraint
 *
 * Self-contained by requirement: no external CSS, fonts, scripts or
 * images. The Worker returns this one string and nothing else loads —
 * which is also why the inline SVG carries no xmlns (an inline SVG in
 * HTML needs none, and the attribute's URL would trip the guard that
 * proves nothing off-domain is referenced).
 *
 * This page is the FLOOR. The apex is meant to be published from Ontold
 * like any other site (founder: "not sure why we can't create the page
 * from the ontold platform"); until a __root publish exists, this is
 * what ontold.site serves, so it has to be good on its own.
 */

import { BRAND_CSS, MARK_SVG, lockSvg } from './brand.mjs';

/** True for the bare domain and www, the two hosts that are the front
 *  door rather than a published site. */
export function isRootHost(host) {
  const h = (host || '').toLowerCase().split(':')[0];
  return h === 'ontold.site' || h === 'www.ontold.site';
}

/** The front door. Static, self-contained, no interpolation. */
export function landingPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ontold.site — sites that started as a sentence</title>
<meta name="description" content="Every address on ontold.site was published by describing a business to Ontold. Make yours at ontold.com.">
<meta name="theme-color" content="#070707">
<style>${BRAND_CSS}
  .caret{
    display:inline-block;width:2px;height:1.05em;vertical-align:-.16em;
    background:var(--bone); margin-left:2px; animation:blink 1.1s steps(1) infinite;
  }
  @keyframes blink{50%{opacity:0}}
  /* The one example that is a real, open-able page rather than a
     sentence. It leads the section because "you can click it" is a
     different claim from "here is what we would make". */
  .live{
    display:flex;align-items:center;justify-content:space-between;gap:1.25rem;
    background:var(--gray);border:1px solid var(--rule);border-radius:14px;
    padding:1.15rem 1.35rem;margin:0 0 2.5rem;text-decoration:none;color:inherit;
    transition:border-color .18s,transform .18s;
  }
  .live:hover{border-color:rgba(220,38,38,.55);transform:translateY(-2px)}
  .live:focus-visible{outline:3px solid var(--red);outline-offset:3px}
  .live-name{
    display:block;
    font:500 15px/1.3 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    color:var(--red);
  }
  .live-name b{color:var(--muted);font-weight:500}
  .live-note{display:block;color:var(--muted);font-size:13.5px;margin-top:.35rem;max-width:46ch}
  .live-go{
    flex:0 0 auto;font-size:13px;font-weight:700;color:var(--bone);white-space:nowrap;
  }
  @media (max-width:560px){
    .live{flex-direction:column;align-items:flex-start;gap:.75rem}
  }
  /* What you type, next to what you get. */
  .examples{margin:4rem auto 0; max-width:600px; text-align:left}
  .label{
    font:700 10px/1 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    letter-spacing:.22em; text-transform:uppercase; color:var(--muted);
    margin:0 0 1rem; text-align:center;
  }
  /* The one example that is a real, open-able page rather than a
     sentence. It leads the section because "you can click it" is a
     different claim from "here is what we would make". */
  .live{
    display:flex;align-items:center;justify-content:space-between;gap:1.25rem;
    background:var(--gray);border:1px solid var(--rule);border-radius:14px;
    padding:1.15rem 1.35rem;margin:0 0 2.5rem;text-decoration:none;color:inherit;
    transition:border-color .18s,transform .18s;
  }
  .live:hover{border-color:rgba(220,38,38,.55);transform:translateY(-2px)}
  .live:focus-visible{outline:3px solid var(--red);outline-offset:3px}
  .live-name{
    display:block;
    font:500 15px/1.3 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    color:var(--red);
  }
  .live-name b{color:var(--muted);font-weight:500}
  .live-note{display:block;color:var(--muted);font-size:13.5px;margin-top:.35rem;max-width:46ch}
  .live-go{
    flex:0 0 auto;font-size:13px;font-weight:700;color:var(--bone);white-space:nowrap;
  }
  @media (max-width:560px){
    .live{flex-direction:column;align-items:flex-start;gap:.75rem}
  }
  .examples ul{list-style:none;margin:0;padding:0}
  .examples li{
    display:flex; align-items:baseline; justify-content:space-between;
    gap:1.25rem; padding:.95rem 0; border-top:1px solid var(--rule);
  }
  .said{
    font-family:'Instrument Serif',Georgia,"Times New Roman",serif;
    font-style:italic; font-size:clamp(15px,2.2vw,18px); color:var(--bone);
  }
  .got{
    font:500 13px/1 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    color:var(--red); white-space:nowrap; flex:0 0 auto;
  }
  .got b{color:var(--muted);font-weight:500}
  @media (max-width:560px){
    .examples li{flex-direction:column;gap:.4rem}
    .got{white-space:normal}
  }
  footer{
    margin-top:3.5rem; padding-top:1.5rem; border-top:1px solid var(--rule);
    color:var(--muted); font-size:13px; text-align:center;
  }
  footer a{color:var(--bone)}
  @media (prefers-reduced-motion:reduce){.caret{animation:none}}
</style></head>
<body><main>
  ${MARK_SVG}
  <p class="eyebrow">ontold.site</p>

  <div class="bar">
    ${lockSvg(true)}
    <div class="addr"><span class="slug" id="slug">sunrise-bakery</span><span class="rest">.ontold.site</span><span class="caret" id="caret"></span></div>
  </div>

  <h1>Every address here started as <em>a sentence</em>.</h1>
  <p class="lede">Describe the business. Ontold writes the site, publishes it, and hands back a live address like this one.</p>
  <a class="cta" href="https://ontold.com">Make yours</a>

  <section class="examples">
    <p class="label">One you can actually open</p>
    <a class="live" href="https://nothing-to-wear.ontold.site">
      <span class="live-copy">
        <span class="live-name">nothing-to-wear<b>.ontold.site</b></span>
        <span class="live-note">A capsule wardrobe you can filter, pick from, and total up &mdash; live, and running entirely inside one page.</span>
      </span>
      <span class="live-go" aria-hidden="true">Open &rarr;</span>
    </a>

    <p class="label">What you type, and what you get</p>
    <ul>
      <li><span class="said">&ldquo;a lead generation site for driving instructors&rdquo;</span><span class="got">ridgeway-driving<b>.ontold.site</b></span></li>
      <li><span class="said">&ldquo;a bakery that opens at six and sells out by ten&rdquo;</span><span class="got">sunrise-bakery<b>.ontold.site</b></span></li>
      <li><span class="said">&ldquo;a family dental practice taking new patients&rdquo;</span><span class="got">ridgeline-dental<b>.ontold.site</b></span></li>
    </ul>
  </section>

  <footer>Example addresses shown above &mdash; illustrative, not customers. The studio lives at <a href="https://ontold.com">ontold.com</a>.</footer>
</main>
<script>
(function(){
  var names = ['sunrise-bakery','orbital-coffee','ridgeline-dental','the-corner-salon','hartwell-legal'];
  var slug = document.getElementById('slug');
  var lock = document.getElementById('lock');
  var caret = document.getElementById('caret');
  if (!slug || !lock) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    caret && caret.remove();
    return; // one static address, lock already closed
  }
  var i = 0;
  function type(name, done){
    lock.classList.remove('secure');
    var n = 0;
    (function step(){
      slug.textContent = name.slice(0, n);
      if (n++ <= name.length) return setTimeout(step, 38);
      lock.classList.add('secure');   // the moment: name exists, TLS valid
      setTimeout(done, 1900);
    })();
  }
  function erase(done){
    var t = slug.textContent;
    (function step(){
      t = t.slice(0, -1);
      slug.textContent = t;
      if (t.length) return setTimeout(step, 22);
      done();
    })();
  }
  function loop(){
    i = (i + 1) % names.length;
    erase(function(){ type(names[i], loop); });
  }
  setTimeout(loop, 1900);
})();
</script>
</body></html>`;
}
