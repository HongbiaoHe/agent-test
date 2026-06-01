---
name: content-strategy-models
description: Prefer to load before any creative deliverable — image generation, video generation, copywriting, or strategy work — so the chosen narrative model becomes the upstream brief downstream producers read from. Selects from 8 marketing narrative models (PAS / AIDA / FAB / USP / 4P / BBE / Slide Effect / HSO) based on product category × audience awareness level (skeleton selection), then applies the user-picked big-idea route's driver / insight / tone / visual direction as a coloring layer over the skeleton, then outputs two-layer phase directives that producers inject into each asset. Works for single image / single ad, single ≤15s video (all phases inside the 15s clip cap), long video scripts that must split into multiple ≤15s clips (phases allocated across clips — single ≤15s clip cap is owned by `video-script-framework`), carousels, sales pages, and multi-touchpoint campaigns. Skip only for local edits, pure resize / format conversion, or raw Q&A with no creative deliverable.
---


# Content Strategy Models

This skill is the narrative model library for content that has structure — carousels, multi-slide ads, sales pages, long-form sequences. It picks the best-fit model and structures the content phases.

In 2026, generic content (no narrative model) underperforms because audiences have pattern-recognized standard marketing structures. The model used here provides a clear narrative arc that audiences subconsciously follow.

## Apply

### 1. Select Model from the Library

Model skeleton selection is a **soft recommendation** driven by two inputs, NOT a single goal:

1. **Product category** — what kind of product / service is this
2. **Audience awareness level** — Schwartz 5 stages (Unaware / Problem-aware / Solution-aware / Product-aware / Most-aware)

If either input is missing from upstream brief → halt and request Brief Tear Down to supply before continuing. Do NOT guess.

#### Step A — Product category → model candidates

| Product / Service Type | Primary | Secondary |
|---|---|---|
| Pain-point (health / efficiency / acne / sleep / weight) | PAS | BBE, 4P |
| Technical / SaaS / electronics (spec-heavy) | FAB | AIDA, 4P |
| Habit change / wellness / fitness / self-improvement | BBE | PAS |
| FMCG retail (food & bev / beauty / daily goods) | AIDA | Slide Effect, USP |
| High-ticket / luxury / premium services | HSO | AIDA, USP |
| Founder IP / creator economy / knowledge product | HSO | Slide Effect |
| Competitive differentiation / new category | USP | PAS+USP (composite) |
| Data-driven result product (finance / growth / marketing) | 4P | AIDA, USP |

#### Step B — Audience awareness → model lean

| Awareness Level | Lean |
|---|---|
| Unaware (doesn't know the problem) | 4P, AIDA (build awareness first) |
| Problem-aware (knows problem, not solution) | PAS, BBE |
| Solution-aware (knows solution, not you) | USP, FAB |
| Product-aware (knows you, not yet bought) | AIDA, 4P |
| Most-aware (wants exactly you) | HSO, USP (light reminder + direct CTA) |

#### Step C — Soft recommendation algorithm

```
candidates = (Step A's Primary ∪ Secondary) ∩ Step B's lean
if candidates is non-empty:
    pick = candidates[0]  (prefer Step A's Primary if it's in the intersection)
else:
    pick = Step A's Primary  (product category fallback)

Internal trace (NOT shown to user):
"Picked {model} because product_category={category} × awareness={level} → {reasoning}."
```

Composite models stay available via Composition Rules below (USP+PAS for competitive pain-point ads; HSO+AIDA for founder-led conversion; FAB+BBE for habit-tech; AIDA+USP for general attention + category disruption).

### 1.5 Direction Coloring (from selected big-idea route)

After the model skeleton is chosen, **always apply the user-selected big-idea route as a coloring layer**. The skeleton is the structure (PAS / AIDA / …); the route is what fills it with voice and image.

#### Input Contract — read these 4 fields from selected route

- `driver` — exactly one C (Consumer / Category / Culture / Company)
- `central insight` — one sentence
- `tone / voice` — a named register (e.g. "confident-restrained", "calm-observational", "playful-conspiratorial")
- `key visual direction` — 2-3 concrete elements (palette / framing / subject)

If any of the 4 fields is missing or vague ("modern", "engaging", "emotional") → halt and ask `big-idea-concept-pitching` to refill with specificity. Do NOT proceed with vague color inputs.

#### Coloring rules — every phase carries 4 layers of color on top of skeleton

| Color Layer | Rule |
|---|---|
| Visual coloring | Phase visual anchor MUST pull elements from `key visual direction` (palette / framing / subject). No generic "product hero shot." |
| VO / Copy coloring | `tone / voice` decides diction, sentence length, person (1st / 2nd / 3rd). Tone register cannot be translated into a generic adjective. |
| Insight coloring | Every phase's hook / bridge / closing line must echo `central insight` (direct quote, inverse, or implied — all OK as long as traceable). |
| Driver coloring | Apply the driver's signature mode (see table below). |

#### Driver signature modes

| Driver | Signature mode |
|---|---|
| Consumer | 1st-person / user POV / emotional anchor / pain close-up |
| Category | Comparison / "Old vs New" language / industry deconstruction |
| Culture | Trend / social phenomenon / era-zeitgeist entry / crowd shots |
| Company | Founder / brand-asset / "why us" narrative |

#### Example — same PAS skeleton, 3 different drivers color the Problem phase differently

```
Skeleton (PAS Problem phase):
  Visual must depict the frustration / pain state. No product yet.

Consumer-driven coloring:
  Visual: user alone facing the problem (dim phone screen, stacked desk).
  VO: 1st-person inner monologue.
  Insight echo: "You're not lazy, your tools are slowing you down."

Culture-driven coloring:
  Visual: city crowd shots (commuters on phones, late-night office windows).
  VO: 3rd-person observational / era-commentary register.
  Insight echo: "In the AI era, everyone's burning out — it's not just you."

Company-driven coloring:
  Visual: founder recalling early failure.
  VO: 1st-person founder ("I've been there too…").
  Insight echo: "We built this because we got burned ourselves."
```

### 2. Apply Phase Structure

Users may request any slide count (3, 5, 10, etc.) or any length. Adapt phase weights dynamically:
- First slide / section = model's entry phase (the hook)
- Last slide / section = CTA
- Middle slides / sections = distribute remaining phases by weight ratio
- Single image = model's first phase only (do not compress all phases into one image)

### 3. Video Application — fit phases into ≤15s clips

Single video clip in this system is capped at 15s (model cap, owned by [[video-script-framework]] — do not redefine here). Map the chosen model's phases into the available video budget:

- **Total runtime ≤15s** → one video step. The model's phase ratios become TIME weights inside the 15s window, snapped to scene boundaries. Examples:
  - PAS 15s clip → Problem 0-1.5s / Agitation 1.5-7.5s / Solution 7.5-13.5s / CTA 13.5-15s
  - AIDA 12s clip → Attention 0-1.2s / Interest 1.2-4.8s / Desire 4.8-10.8s / Action 10.8-12s
  - Slide Effect 15s clip → Cliffhanger 0-1.5s / Story Build 1.5-10.5s / Reveal 10.5-13.5s / CTA 13.5-15s
- **Total runtime >15s** → split into multiple ≤15s video steps (each clip = one `propose_batch_plan` step). Allocate phases ACROSS clips, never inside one clip:
  - 30s PAS → Clip A (15s): Problem + Agitation · Clip B (15s): Solution + CTA
  - 45s AIDA → Clip A (15s): Attention + Interest · Clip B (15s): Desire · Clip C (15s): Social Proof + Action
  - 30s HSO → Clip A (15s): Hook + Story setup · Clip B (15s): Story climax + Offer + CTA
- Each clip step description must carry its phase directive ("This clip executes the PROBLEM + AGITATION phases of a PAS arc — open on the pain state, escalate stakes; do not show product yet") so Video Producer drafts the right script for that segment.
- Phase splits should land on natural narrative breaks (end of agitation, end of story build). Never cut mid-phase across two clips.

## Model Library

### Model 1 — PAS (Problem / Agitation / Solution)

- Best for: pain-point products, direct response, acne / health / efficiency tools
- Phase ratio: Problem 10% / Agitation 40% / Solution 40% / CTA 10%
- Tone: Empathetic, urgent, authoritative
- 10-slide template:
  - Slide 1 (Problem): identify specific, relatable pain point that stops the scroll
  - Slides 2-4 (Agitation): amplify emotional frustration — hidden costs, long-term damage of inaction
  - Slides 5-8 (Solution): introduce product as cure; detail how core features eliminate the pain
  - Slide 9 (Transformation): show the "After" — relief, success, satisfaction
  - Slide 10 (CTA): high-urgency command to buy / sign up
- 3-slide compression: Problem (1) / Agitation+Solution (2) / CTA (3)
- 5-slide compression: Problem (1) / Agitation (2-3) / Solution (4) / CTA (5)
- Video shot design (single 15s clip, long tier):
  - 0-1.5s · PATTERN_INTERRUPT / Problem · Visual: tight close-up on the pain state (visible frustration, broken object, error screen). Camera: handheld micro-shake. VO direction: contrarian or shocking-stat opener. Overlay: ≤6-word hook on the pain.
  - 1.5-7.5s · MECHANISM / Agitation · Visual: 3 quick cuts (~2s each) escalating consequences — hidden cost → time loss → worst-case. Camera: jump-cut or whip-pan; rising audio bed. VO direction: stakes-amplification, second-person ("you" / "你"). Overlay: data point or worst-case label.
  - ~7.5s · OPEN_LOOP · VO bridge "But here's what nobody tells you…"; 1-frame black or hard contrast cut. Overlay: none — let the bridge breathe.
  - 7.5-13.5s · MECHANISM / Solution · Visual: clean product reveal; one feature in action; user's relief expression. Camera: stable, slower pace. VO direction: cause→effect ("X eliminates Y"). Overlay: feature name only.
  - 13.5-15s · CTA · Visual: product still + overlay text. VO + Overlay carry the SAME imperative ≤6 words ("Save this.").
- Compressed tiers: mid (6-10s) drops Agitation to 1 cut + folds Open Loop into Solution's closing line; short (≤5s) fuses Problem-tease + CTA into one shot.
- Split if >15s (e.g. 30s) → Clip A ends on the worst Agitation beat as cliffhanger · Clip B opens directly on the Solution reveal, no re-intro.

### Model 2 — AIDA (Attention / Interest / Desire / Action)

- Best for: general ads, promotions, lead nurture, product launches
- Phase ratio: Attention 10% / Interest 30% / Desire 40% / Action 10%
- Tone: Engaging, aspirational, persuasive
- 10-slide template:
  - Slide 1 (Attention): scroll-stopping hook or bold visual statement
  - Slides 2-4 (Interest): 3 intriguing facts or unique angles about the product
  - Slides 5-8 (Desire): "Aspired Lifestyle" storytelling — show how product elevates user's life
  - Slide 9 (Social Proof): testimonial / authority stamp / trust signal
  - Slide 10 (Action): direct instructions to purchase now
- 3-slide compression: Attention (1) / Interest+Desire (2) / Action (3)
- Video shot design (single 15s clip, long tier):
  - 0-1.5s · PATTERN_INTERRUPT / Attention · Visual: bold visual statement — oversize hero object, color-pop, or impossible scenario. Camera: hard cut-in. VO direction: aspirational headline or "What if…". Overlay: 1-line hook.
  - 1.5-6s · MECHANISM / Interest · Visual: 3 angles on a unique product facet — close-up detail → in-context use → reaction shot. Camera: smooth match-cuts. VO direction: 3 facts in rhythm. Overlay: each fact's keyword.
  - ~7.5s · OPEN_LOOP · "But the real reason you'd want this…" bridges into Desire. Camera: slow push-in.
  - 6-12s · MECHANISM / Desire · Visual: aspired-lifestyle vignette — product in the user's elevated future. Camera: cinematic stable framing, warm grade. VO direction: sensory + future-tense. Overlay: none — let visuals carry.
  - 12-13.5s · PROOF · Visual: testimonial title card or trust badge insert. Camera: quick cut. VO direction: third-party validation in one line. Overlay: source name / quoted line.
  - 13.5-15s · CTA / Action · Visual: product + overlay. VO + Overlay: direct purchase imperative.
- Compressed tiers: mid (6-10s) collapses Interest into a single cut + drops Proof; short (≤5s) keeps Attention + CTA only, fused into one shot.
- Split if >15s (e.g. 30s) → Clip A ends on Interest's hardest fact as an open loop · Clip B opens on the Desire vignette and closes with Proof + CTA.

### Model 3 — 4P (Promise / Picture / Proof / Push)

- Best for: result-oriented products, quantifiable outcomes, data-driven campaigns
- Phase ratio: Promise 10% / Picture 30% / Proof 40% / Push 10%
- Tone: Confident, evidence-based, conversion-focused
- 10-slide template:
  - Slide 1 (Promise): bold, quantifiable promise of specific result
  - Slides 2-4 (Picture): vivid mental picture of user's ideal future after using product
  - Slides 5-8 (Proof): hard evidence — data, screenshots, before/after cases, third-party validation
  - Slide 9 (Push): limited-time bonus or address major objection head-on
  - Slide 10 (CTA): clear push to checkout page
- Video shot design (single 15s clip, long tier):
  - 0-1.5s · PATTERN_INTERRUPT / Promise · Visual: data card or before/after split-screen flashing the quantified result. Camera: static type-driven shot. VO direction: declarative ("In 7 days, X."). Overlay: the number, oversize.
  - 1.5-6s · MECHANISM / Picture · Visual: 2-3 cuts of the user's ideal future state (morning routine without friction, dashboard glowing green). Camera: match-on-action. VO direction: second-person future ("imagine…" / "你将…"). Overlay: outcome label.
  - ~7.5s · OPEN_LOOP · "Sounds too good? Here's the receipts." Camera: hard cut into the first proof asset.
  - 6-12s · PROOF · Visual: rapid evidence montage — graph / before-after / press logo / 2 customer faces with captions. Camera: cuts at ~1.5s each. VO direction: read the data, no embellishment. Overlay: each metric or source.
  - 12-13.5s · PROOF / Push · Visual: limited-time bonus card or scarcity timer. VO direction: address top objection in 1 line. Overlay: bonus / deadline.
  - 13.5-15s · CTA · Visual: product + button overlay. VO + Overlay: direct push imperative.
- Compressed tiers: mid (6-10s) compresses Proof to 2 cuts + drops Push; short (≤5s) keeps Promise + CTA only.
- Split if >15s (e.g. 30s) → Clip A ends after Picture as the open loop ("here's the receipts →") · Clip B opens on the Proof montage and closes with Push + CTA.

### Model 4 — FAB (Feature / Advantage / Benefit)

- Best for: technical products, SaaS, electronics, spec-heavy goods
- Phase ratio: Hook 10% / FAB Chapters 70% / Summary 10% / CTA 10%
- Tone: Educational, informative, benefit-centric
- 10-slide template:
  - Slide 1: Hook based on most impressive technical capability
  - Slides 2-8: Chapter-based breakdown — for each core Feature, explain Advantage (better than alternatives) and ultimate Benefit (why user cares)
  - Slide 9: Summarize value proposition in one powerful sentence
  - Slide 10 (CTA): invitation to explore full specs or buy
- Video shot design (single 15s clip, long tier — runs 2 FAB micro-chapters):
  - 0-1.5s · PATTERN_INTERRUPT / Hook · Visual: hero shot of the most impressive capability in action (macro on a sensor, zoom into a mechanism). Camera: cinematic push-in. VO direction: capability claim in one sentence. Overlay: spec keyword.
  - 1.5-6.75s · MECHANISM / FAB chapter 1 · Visual: feature in action → side-by-side vs alternative → user benefit reaction. 3 cuts. VO direction: F→A→B in one breath. Overlay: F label / A delta / B outcome.
  - ~7.5s · OPEN_LOOP · "And that's just one — the next one is what makes it worth it." Camera: title-card transition.
  - 6.75-12s · MECHANISM / FAB chapter 2 · Visual: same 3-cut F→A→B pattern on the second feature. VO direction: parallel structure to chapter 1. Overlay: same scheme.
  - 12-13.5s · PROOF / Summary · Visual: product on hero stand + spec list overlay. Camera: stable. VO direction: one-sentence value proposition. Overlay: tagline.
  - 13.5-15s · CTA · Visual: product + CTA overlay. VO + Overlay: "See full specs" / "Get yours".
- Compressed tiers: mid (6-10s) keeps Hook + 1 FAB chapter + CTA; short (≤5s) fuses Hook + benefit claim + CTA into a single declarative shot.
- Split if >15s (e.g. 30s) → one ≤15s clip per chapter: Clip A: Hook + FAB chapter 1 ending on the "next one is bigger" open loop · Clip B: FAB chapter 2 + Summary + CTA.

### Model 5 — USP (Unique Selling Proposition / Differentiation)

- Best for: competitive markets, category disruption, "why switch" campaigns
- Phase ratio: Old Way 30% / New Way 40% / Justify 20% / CTA 10%
- Tone: Bold, confrontational, category-defining
- 10-slide template:
  - Slides 1-3 (Old Way): expose the "old / boring" way the industry does things; make status quo feel outdated
  - Slides 4-7 (New Way): reveal YOUR product as the "New Way" — category of one
  - Slides 8-9 (Justify the Switch): address switching costs and objections; make the case irresistible
  - Slide 10 (CTA): clear instruction to make the switch now
- Video shot design (single 15s clip, long tier):
  - 0-1.5s · PATTERN_INTERRUPT / Old Way intro · Visual: stylized boring/outdated scene (beige tones, sluggish gestures, retro UI). Camera: static framing, desaturated grade. VO direction: contrarian — "Everyone still does X the slow way." Overlay: "OLD WAY" label.
  - 1.5-4.5s · MECHANISM / Old Way detail · Visual: 2 cuts showing the pain of the old way — wasted steps, frustration. Same desaturated grade. VO direction: list 2 absurdities. Overlay: friction count.
  - 4.5-10.5s · MECHANISM / New Way · Visual: HARD cut to vibrant grade — brand palette floods in; product appears in elevated context. 3 cuts at ~2s. VO direction: declare the new category. Overlay: "NEW WAY" label + product category line.
  - ~7.5s · OPEN_LOOP · "But will it actually work for you?" — fold into New Way's closing cut as the transition into Justify.
  - 10.5-13.5s · PROOF / Justify · Visual: switching-cost teardown — comparison card, migration-ease shot, "free to switch" line. VO direction: dismantle the top switching objection. Overlay: objection + counter.
  - 13.5-15s · CTA · Visual: product + bold overlay. VO + Overlay: "Switch today." imperative.
- Compressed tiers: mid (6-10s) collapses Old Way to a single cut and holds the hard cut to New Way as the centerpiece; short (≤5s) plays only the Old Way → New Way hard cut + CTA.
- Split if >15s (e.g. 30s) → Clip A is the full Old Way teardown ending on the worst frustration beat · Clip B opens with the hard cut to New Way and runs Justify + CTA.

### Model 6 — BBE (Behavior / Benefit / Evidence)

- Best for: habit-change products, wellness, health, fitness, self-improvement
- Phase ratio: Behavior 30% / Benefit 30% / Evidence 30% / CTA 10%
- Tone: Empowering, scientific, motivational
- 10-slide template:
  - Slides 1-3 (Behavior): target a current bad habit to break OR new positive habit to start
  - Slides 4-6 (Benefit): immediate and long-term rewards of changing that behavior
  - Slides 7-9 (Evidence): clinical studies, verified user transformations, expert endorsements
  - Slide 10 (CTA): take the first step — download, subscribe, buy now
- Video shot design (single 15s clip, long tier):
  - 0-1.5s · PATTERN_INTERRUPT / Behavior call-out · Visual: close-up on the bad/new behavior in action (slumped posture, late-night screen scroll, OR hero gesture of the new habit). Camera: documentary feel, natural light. VO direction: direct address — "If you still [behavior]…". Overlay: behavior name.
  - 1.5-4.5s · MECHANISM / Behavior detail · Visual: 2 cuts dramatizing the behavior's hidden cost or upside. Camera: handheld observational. VO direction: name the stake. Overlay: data tag (e.g. "−18 min/day").
  - 4.5-9s · MECHANISM / Benefit · Visual: 3 short-term-then-long-term cuts — Week 1 → Month 1 → 6 Months. Camera: match-cut on the user's body posture or environment change. VO direction: immediate→long-term reward sequence. Overlay: time tags ("Week 1 / Month 6").
  - ~7.5s · OPEN_LOOP · "Sounds soft? The study is wild." Camera: hard cut into the evidence card.
  - 9-13.5s · PROOF / Evidence · Visual: clinical study card → expert headshot → transformation before/after. 3 quick cuts. VO direction: cite the source flatly. Overlay: study name / expert title / metric.
  - 13.5-15s · CTA · Visual: product + overlay. VO + Overlay: "Start today." imperative.
- Compressed tiers: mid (6-10s) keeps Behavior call-out + Benefit montage + CTA, drops Evidence; short (≤5s) fuses Behavior + Benefit promise + CTA into a single direct-address shot.
- Split if >15s (e.g. 30s) → Clip A: Behavior + Benefit, ending on the "is this real?" open loop · Clip B: Evidence + CTA.

### Model 7 — Slide Effect (The Copywriter's Slide)

- Best for: viral storytelling, narrative-driven engagement, curiosity-based content
- Phase ratio: Cliffhanger 10% / Story Build 60% / Reveal 20% / CTA 10%
- Tone: Conversational, punchy, short sentences, open-loop suspense
- 10-slide template:
  - Slide 1: Start with a cliffhanger — open loop that forces the swipe
  - Slides 2-8: Build frictionless narrative; every slide ends with an open loop; sentences are short and punchy
  - Slide 9: The "Big Reveal" — product solves the story's central tension
  - Slide 10 (CTA): logical next step after story concludes
- Video shot design (single 15s clip, long tier — the open-loop centerpiece is the soul of this model):
  - 0-1.5s · PATTERN_INTERRUPT / Cliffhanger · Visual: mid-action shot of an unresolved moment (something dropped mid-air, an open door, a hand reaching). Camera: tight framing, no establishing. VO direction: open-loop one-liner ("I almost didn't post this…"). Overlay: provocative fragment ending in "…".
  - 1.5-10.5s · MECHANISM / Story Build · Visual: 4-5 quick story beats at ~2s each — each cut should END on another open loop (gesture cut-off, dialogue interrupted). Camera: handheld, vlog grade. VO direction: short punchy sentences; every beat closes with "and then…". Overlay: pacing keywords, never the full reveal.
  - ~7.5s · OPEN_LOOP (centerpiece) · The story's biggest mystery line ("…and that's when I realized") lands at the 50% mark. Camera: pause / freeze-frame for a half-beat.
  - 10.5-13.5s · PROOF / Reveal · Visual: product enters frame as the answer to the story's tension. Camera: wider shot for breathing room. VO direction: the reveal sentence — single line that resolves the loop. Overlay: product name.
  - 13.5-15s · CTA · Visual: product + overlay. VO + Overlay: logical next step ("Get the link.").
- Compressed tiers: mid (6-10s) cuts Story Build to 2 beats but KEEPS the centerpiece open loop (the model dies without it); short (≤5s) plays cliffhanger + reveal only, fusing CTA into the Reveal line.
- Split if >15s (e.g. 30s) → Clip A ends on the centerpiece mystery line ("…and that's when I realized") with NO reveal · Clip B opens with the reveal moment and closes with CTA.

### Model 8 — HSO (Hook / Story / Offer)

- Best for: personal brands, founder stories, creator economy, journey-based content
- Phase ratio: Hook 10% / Story 60% / Offer 20% / CTA 10%
- Tone: Vulnerable, authentic, relatable, inspirational
- 10-slide template:
  - Slide 1 (Hook): controversial statement or massive attention-grabbing result
  - Slides 2-7 (Story): vulnerable journey — struggle, failures, "Aha!" moment of discovery
  - Slides 8-9 (Offer): introduce product as tool / method that made the result possible
  - Slide 10 (CTA): specific call to action — lead magnet, shop link, community invite
- Video shot design (single 15s clip, long tier):
  - 0-1.5s · PATTERN_INTERRUPT / Hook · Visual: founder/creator-to-camera, eye-level, intimate framing. Camera: natural light, slight handheld. VO direction: controversial statement or result claim ("I made $X in 90 days because of one habit."). Overlay: the result, oversize.
  - 1.5-7.5s · MECHANISM / Story setup · Visual: 3 personal beats — before state (struggle) → low moment (failure) → discovery cut (the "aha"). Camera: mix of self-shot footage / b-roll. VO direction: vulnerable first-person. Overlay: timestamp tags ("Year 1 / Year 2 / The shift").
  - ~7.5s · OPEN_LOOP · "…and what changed everything was this." Camera: hold on the creator's face just before the cut.
  - 7.5-10.5s · MECHANISM / Story climax · Visual: the discovery moment dramatized — product/method first appears INSIDE the world of the story (not as an ad). VO direction: name the method/product as PART of the story. Overlay: method/product name.
  - 10.5-13.5s · PROOF / Offer · Visual: creator holding / using the product, or product card with the offer line. Camera: steady. VO direction: position the offer as the tool that made the result possible. Overlay: offer specifics.
  - 13.5-15s · CTA · Visual: creator-to-camera again + overlay. VO + Overlay: specific CTA ("Link in bio.").
- Compressed tiers: mid (6-10s) collapses Story to "low moment → discovery" 2-cut + Offer + CTA; short (≤5s) keeps Hook (the result claim) + CTA only.
- Split if >15s (e.g. 30s) → Clip A: Hook + Story setup (struggle + low moment), ending on the "what changed everything was this →" open loop · Clip B: Story climax + Offer + CTA, no re-introduction.

## Composition Rules

Models can be combined when single model doesn't fully cover the scenario:

- USP + PAS: differentiate first (Old Way vs New Way), then drive conversion through pain-agitation
- HSO + 4P: founder story for emotional hook, then hard proof and promises
- FAB + BBE: technical feature education combined with behavior-change framing
- AIDA + USP: general attention funnel backed by category disruption

Existing campaign skills (Campaign Plan sub-scenarios: Product Launch, Flash Sale, Traffic Engine, Premium Trust) compose naturally — they handle channel / budget strategy while this skill handles content narrative structure.

## Step Description Injection (downstream contract)

After picking the skeleton model + reading the selected big-idea route's 4 color fields, inject **two-layer** phase directives into each downstream step's description. Producers MUST read both layers — `[Skeleton]` defines the structural role, `[Color from Route N — {Driver}]` defines how to fill it with this campaign's voice and image.

**Template — 2-layer phase directive:**

```
"<Action verb> <asset N>: <PHASE NAME> phase.

 [Skeleton]
   <Phase's structural mission from the chosen model — visual role, narrative beat, no-go (e.g. 'no product yet').>

 [Color from Route {N} — {Driver} driver]
   Insight echo: '<central insight short-form>'.
   Visual elements: <2-3 concrete elements pulled from key visual direction>.
   Tone: <named tone register>.
   Driver mode: <one-line driver signature application>."
```

**Concrete example — PAS Problem phase for Slide 1, Image Producer, Route 2 (Culture-driven):**

```
"Design Slide 1: PROBLEM phase.

 [Skeleton]
   Visual depicts the frustration / pain state. No product yet. Raw, relatable.

 [Color from Route 2 — Culture driver]
   Insight echo: 'AI era — everyone's burning out, not just you.'
   Visual elements: muted city palette, isolated figures in crowd, late-night windows.
   Tone: observational-detached.
   Driver mode: crowd / era-commentary shot, NOT user close-up."
```

**Rules:**
- Both layers MUST appear in every phase directive — no single-layer directives
- `[Color from Route N]` uses the exact Route number / driver the user picked, not a guess
- If skeleton phase has multiple sub-beats (e.g. PAS Agitation = 3 cuts), each sub-beat keeps the same color layer

## Output Format

- Model selection + rationale (1 sentence)
- Phase structure with slide / section allocation
- Per-phase directives ready to inject into downstream producer skills
- Combined models (if applicable) with how they interleave

## Defaults

- No model specified by user → run Step A × Step B soft-recommendation algorithm; if product category or awareness level is missing from Brief Tear Down, halt and request upstream to supply
- No slide count specified → default to 5 slides (carousel sweet-spot)
- Single image / single asset → use model's entry phase only, do not compress all phases
- Single video clip with no duration specified → fit all phases into 15s (the per-clip model cap; see `video-script-framework` for the duration tier rules)
- Video runtime >15s requested → automatically split into multiple ≤15s clips and allocate phases across clips per §3

## Hard Limits

- Internal Knowledge Only: model names (PAS, AIDA, FAB, USP, 4P, BBE, Slide Effect, HSO) are INTERNAL strategic knowledge. NEVER expose them in user-facing text — not in confirmation prompts, key messages, summaries, or step descriptions. Describe strategy in plain natural language focused on what content will achieve, not which model is being used.
- Never skip phases — if compressing to fewer slides, merge phases; do not omit them entirely
- Never use the same model for every campaign — reuse degrades performance; mix models across a content calendar
- Phase ratios are guides, not rules — in compression, weights shift; do not over-constrain when slide count is low
- Never plan a single video step longer than 15s — the per-clip cap is enforced by `video-script-framework`. Longer arcs MUST split into multiple ≤15s clips with phases allocated across clips, not compressed inside one clip.
- Never cut a phase mid-way across two clips — phase splits must land on natural narrative breaks.

## Cross-Reference

- Brief Tear Down: provides Goal field that drives model selection
- `big-idea-concept-pitching`: this skill MUST read the user-selected route's 4 fields (driver / central insight / tone / key visual direction) as the coloring inputs. If any field is missing or vague, halt and request upstream to refill before continuing.
- Ad Copywriting / Editorial Content: receives phase directives from this skill; this skill structures, they write
- Image Producer / Video Producer: receives phase directives for visual phase work (Problem visual vs Solution visual etc.). For video, the per-clip ≤15s cap and pacing tiers are owned by `video-script-framework` — this skill only allocates phases inside the 15s window or across split clips
- Campaign Plan: Campaign Plan's sub-scenarios (Product Launch / Flash Sale / etc.) operate on channel + funnel layer; this skill operates on content narrative layer; they compose