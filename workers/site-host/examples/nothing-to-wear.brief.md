# Rebuild brief — Nothing to Wear

The specification that must reproduce `nothing-to-wear.ontold.site`.

Founder (2026-07-31): *"everything we are creating needs to be made from
our generator and if the ability is missing, create it, thats the point -
dogfooding with examples"* — see issue #89.

This file is the input, not documentation of the output. The acceptance
test is that running it through the generator produces the published
page, and that every gap is closed **in the generator, never by editing
the result**. When the generated page is the published one, the
`written by hand` admission in the example's footer can be deleted
honestly. Until then it stays, and this demo is decoration.

---

## What the user types

This blockquote, and ONLY this, is what gets sent. Founder (2026-08-01):
*"some stuff is literally meant to be examples of what a user types - not
us showing our additional things to make it wow."* Everything after it is
the acceptance criteria we judge the output against — our homework, not
the generator's input. Handing over the specification would measure
nothing.

> A private digital wardrobe called **Nothing to Wear**. I own thirty
> things and I'm still standing in front of a full rail with no idea what
> goes together. Tell it what the day is — what I'm doing, what it's
> doing outside, how I want to feel — and it builds complete outfits out
> of what I already own, tells me why each one works, what to do with my
> hair and face, and which drawer every piece is in. Show me my colour
> family and which of my clothes sit outside it. Pack me a capsule for a
> trip. And tell me honestly where the gaps are, because sometimes I
> really do have nothing to wear.

That paragraph is the whole ask, and it is all the generator gets.
Everything below is what it has to be able to DO to satisfy it — the
measurement, not the prompt.

---

## 1. The artefact class

This is not a landing page. A landing page is **presentation**: prose,
layout, a call to action — which is what `landing-page-builder` produces
today and validates through `isSubstantialSite`.

This is **data + rules + presentation**, and the first two are the gap:

| Layer | What it is here |
|---|---|
| Data | 30 typed garments, each with ~15 attributes |
| Rules | Composition, colour arithmetic, packing, gap counting, statistics |
| Presentation | App shell, flat-lay compositions, insight panels |

A generator that can only emit the third layer cannot make this page, no
matter how good the copy is.

## 2. The data model

Every garment carries, and nothing may be inferred at render time that
isn't here:

```
id, name, short name          identity
category                      tops · knit · bottoms · dress · outer · shoes · accessory
shape                         which flat is drawn when there is no photograph
price, note, storage spot     "Second drawer, under the jeans"
hex                           sampled from the garment's own photograph
occasions[]                   work · weekend · dinner · travel
warmth 0–3, rain true|false   what it actually keeps out
tone light|mid|dark           value, for contrast
temperature warm|cool|accent  undertone, and which piece is the colour
volume, texture               proportion and cloth
photo                         a data: URI, or absent
```

Plus a palette as data — colour families of named shades with hex values
and core anchors flagged.

**Why typed and not prose:** every sentence the page says is derived from
these fields. A hardcoded outfit list with hand-written blurbs looks
identical on day one and starts lying the moment a garment changes.

## 3. The rules the generator must emit

Each of these is load-bearing. A generated page missing any one of them
is not this page.

**Look composition.** Enumerate every valid top + bottom + shoes, plus
dress-based looks that skip both slots, filtered by occasion, weather and
mood. Rain constrains what touches the ground and what goes over the top
— never the top itself, that is what a coat is for. Cold requires real
warmth, not a coat thrown over summer clothes. When a slot empties, refill
it from the whole wardrobe and **name the compromise**: *"the boots are
not a dinner choice. Wearing them anyway: the only thing that survives
the rain."*

**Colour.** Nearest palette shade by RGB distance, reported as the
distance with a band drawn on it — never as an invented 0–100 score.
Value contrast, warm-versus-cool mixing, and at most one accent piece.

**Proportion.** Volume against volume needs a tuck; fitted-and-wide is
the easy one; texture named from the cloth.

**Grooming.** Hair and face answer the occasion; rain overrides the hair.

**Accessories.** A tote carries a laptop, so work and travel; everything
else gets the crossbody, chosen to CONTRAST the outfit's tone. The small
piece answers the weather first — cold wants the scarf — then the
occasion: a watch for work and dinner, sunglasses for weekends and travel.

**Packing.** Greedy on outfits-per-piece, seeded with one of each
essential slot first, weighted by warmth when cold and rain-readiness
when wet, and always one coat.

**Gaps.** Count complete looks for all twelve occasion/weather pairs and
name the slot doing the limiting.

**Statistics.** How many pieces reach a complete look, which appears in
the most, which appear in none, how many sit outside the palette.

## 4. The honesty constraints

These are output rules, not editorial preferences, and they are the
hardest part to generate:

1. **Every figure is computed.** The reference mockup shows *"using 68%
   of your wardrobe"*, *"most worn"*, *"not worn in 32 days"* — all of
   which need wear history a page with no account cannot have. Do not
   print them. Show what the data can prove instead, on the same shelf.
2. **Name what the page cannot do.** No forecast is fetched, no photo is
   uploaded, no try-on is generated — each said plainly, with a handoff
   to the studio rather than a mock.
3. **A page may CARRY an image but never FETCH one.** `data:` URIs only.
   Hand it an http URL and it must fall back to the drawing.
4. **Say when it is a demonstration.** Invented prices, invented storage
   spots, AI-generated garment images — all disclosed.

## 5. Presentation

App shell: sidebar carrying *Today* (doing / weather / mood / nights
away) where every control re-plans the whole page; hero with the current
look; outfit ideas that are the OTHER looks for that same day; a planned
week with no outfit repeated; a right rail of computed insights; and
separate views for the wardrobe, all looks, the calendar, packing and
colour.

Flat-lay: the outfit as one overlapping composition — a coat behind,
shoes low and small, a bag tucked into the corner — never a row of
items, which reads as inventory rather than an outfit.

Self-contained: no external CSS, fonts, scripts or images.

---

## What the generator is missing, precisely

Measured against `services/workaisExpert.ts` as it stands:

- **Cannot emit a dataset.** There is no path that produces 30 typed
  records; the expert returns a document.
- **Cannot emit rules over data.** The output contract is HTML, validated
  only for `</html>`, `</body>` and length.
- **Cannot embed media.** Nothing inlines images as data URIs.
- **Has no honesty contract.** Nothing prevents a generated page from
  printing a figure it cannot compute — which is the failure mode most
  likely to survive review, because invented statistics look right.

The first two are the capability. The fourth is the one that matters
most for trust, and it is the one nobody would notice missing.

## Running it

Not runnable from a sandbox without model keys or reachability to the
generator seam. Run it from the app with this brief as the compose
payload, keep the output verbatim, and diff against
`nothing-to-wear.html`.
