---
name: campaign-plan
description: Use when a brief calls for campaign-level planning (multi-asset, multi-phase, channel mix) — not a single ad. Body first classifies the funnel type (Traffic Engine / Premium Trust / Barbell Split), then routes to one of 4 scenario branches Product Launch (Teaser → Launch → Sustain), Flash Sale / Mega Campaign (Pre-Sale → Peak → Last Chance), Traffic Engine Velocity (high-volume organic sprint), or Premium Trust Funnel (Education → Mechanism → Retargeting). Outputs funnel + channel + cadence + KPI structure.
---


# Campaign Plan

This skill plans campaigns, not single ads. If the user wants "one IG post," this is the wrong skill (route to Ad Copywriting / Editorial Content). Fire when the brief involves:
- Multiple assets over time
- Multi-phase structure (launch / promo / sustain)
- Channel mix decisions
- KPI targets across phases

Before generating the plan, the skill internally classifies the funnel (Traffic Engine / Premium Trust / Barbell Split), which determines which scenario branch to use.

## When to Use

Fire when brief contains:
- launch / drop / reveal / teaser / new product / 上市 / 发布
- sale / promo / Double 11 / flash sale / 促销 / 大促
- viral / organic growth / high volume / 爆款 / 引流
- high-ticket / luxury / B2B / 高端 / 医美
- campaign / plan / roadmap / 活动策划
- 3+ content moments requested in one brief

## Apply

### 1. Barbell Funnel Classification (first step, always)

Before choosing a scenario, classify the funnel:

| Funnel Type | Triggers | Routes to scenario |
|---|---|---|
| Traffic Engine | Low CAC focus, viral intent, mass audience, save-bait formats | Scenario C (Traffic Engine Velocity) |
| Premium Trust | High LTV focus, authority content, niche audience, education arc | Scenario D (Premium Trust Funnel) |
| Barbell Split | Both ends — viral top of funnel + high-value bottom; brand needs both | Mix Scenario C + Scenario D (separate plans) |
| Launch context | New product, time-bounded teaser arc | Scenario A (Product Launch) |
| Sale context | Discount-driven, time-bounded urgency arc | Scenario B (Flash Sale) |

Classification logic:
- New product release with no existing audience? → Product Launch + Premium Trust (build authority during launch) OR Traffic Engine (mass awareness fast)
- Existing brand running a promo? → Flash Sale
- Existing brand needing organic growth? → Traffic Engine Velocity
- High-ticket service (medical, B2B, consulting)? → Premium Trust Funnel

### 2. Route to Scenario

Once classified, run the matching scenario below. Output a full plan with phases, dependencies, KPIs, and channel mix.

---

## Scenario A — Product Launch (Teaser → Launch → Sustain)

Phase 1 — Teaser (7-14 days pre-launch)
- Objective: open an information loop. Product NOT named or shown.
- Surface pain point only. Gate everything else.
- CTA register: zero-commitment — "Follow" / "Save" / "Stay tuned"
- Signal target: Save Rate >3.5%, Follow velocity

Phase 2 — Launch (launch day + 48-72hrs)
- Objective: close the loop with full reveal.
- Product name, mechanism, offer all revealed simultaneously.
- CTA register: medium-high — "Register" / "Book" / "Claim offer"
- Signal target: CTR >1.5%, link clicks

Phase 3 — Sustain (7-28 days post-launch)
- Objective: convert non-converters with social proof.
- Early adopter results, testimonials, belonging signal.
- CTA register: high — "Join [X] people" / "Book before [date]"
- Signal target: Comment depth, retargeting conversions

Dependency Chain:
- Phase 1 steps: dependsOn: [] (parallel within phase)
- Phase 2 steps: dependsOn: [all Phase 1 stepIds]
- Phase 3 steps: dependsOn: [all Phase 2 stepIds]
- Within each phase: Copy before Image; Video depends on locked Copy script

Information Gates:
- Phase 1: REVEAL pain point + launch date signal. WITHHOLD product name, visual, mechanism, price.
- Phase 2: REVEAL everything. The loop closes here.
- Phase 3: REVEAL results + social proof. No new loops.

Hard Limits:
- Never route Phase 2 production before Phase 1 is locked
- Never place a purchase CTA in Phase 1

---

## Scenario B — Flash Sale / Mega Campaign (Pre-Sale → Peak → Last Chance)

Pre-Sale (24-48hrs before)
- Objective: build anticipation, seed the offer
- Copy: tease the discount without full reveal
- Visual: countdown aesthetic, "something big is coming" signal
- CTA: "Set a reminder" / "Add to wishlist" / "Follow for the drop"

Peak Sale (first 6-12hrs — highest urgency)
- Objective: drive maximum immediate purchases
- Copy: full offer revealed; urgency is dominant signal
- CTA: "Add to Cart Now" / "Claim Your [X]% Off"
- Visual: price / discount bold, strikethrough pricing, countdown timer
- Note: urgency mechanics only if factually based on real deadline

Last Chance (final 6-12hrs)
- Objective: convert fence-sitters. FOMO + scarcity signal
- Copy: "Ends in [X] hours" — real time, not fabricated
- Visual: high intensity, urgency overlays, countdown SFX for video
- CTA: same as peak + time qualifier

Zero-Decision CTA Mandate (all copy steps): "CTA must require zero thought. 'Add to Cart Now' not 'Learn More.'"

Urgency Engineering (all visual steps):
- Peak + Last Chance: countdown timer, strikethrough pricing
- Premium Trust brands: soften urgency aesthetic, keep urgency message (no garish red banners)

Platform Priority:
- IG Stories + Reels: highest frequency
- Email: subject line with discount % + deadline
- Paid ads: retarget warm audience with Peak offer immediately

Hard Limits:
- Never manufacture scarcity (fake countdowns, false "only 3 left")
- Discount % must be confirmed before copy is written — do not estimate

---

## Scenario C — Traffic Engine Velocity

Skip Deep Strategy
- needsDeepStrategy: false for pure Traffic Engine tasks
- No 4-paragraph strategy essay — speed is the point
- Exception: multi-channel or brand-new campaign → 1-paragraph max

Maximize Parallelization
- All steps dependsOn: [] unless genuinely sequential
- Goal: every producer skill starts simultaneously
- Time-to-market is the KPI

Save-Bait Format Mandate (Image Producer steps)
- Every static asset: cheat sheet / numbered list / step-by-step grid / save-worthy infographic
- Inject: "Save Rate target >3.5%. Information-dense, scannable, screenshot-friendly."

Comment-to-DM CTA Mandate (Copy steps)
- Every CTA: keyword-trigger format — "Comment [WORD] for the breakdown"
- Not "link in bio." Not "visit our website."
- Inject: "CTA must be keyword-trigger only."

Pattern Interrupt for Video (if in scope)
- First 1.5 seconds: visual or audio shock. No brand. No intro.
- Inject: "Pattern interrupt 0-1.5s mandatory."

Defaults:
- No volume target → 3 assets minimum (1 video hook + 2 static save-bait)
- No pain point → request from user before proceeding

Hard Limits:
- Never apply Premium Trust aesthetic to Traffic Engine assets
- Never manufacture scarcity in CTAs

---

## Scenario D — Premium Trust Funnel (Education → Mechanism → Retargeting)

Step 1 — Education Carousel (Image Producer + Copy)
- Platform: IG or LinkedIn. Format: Carousel 5-7 slides.
- Image style: Cheat Sheet / Save-Bait Layout, data-dense
- Goal: establish authority. CTA: "Save this" only — no purchase ask yet.
- dependsOn: []

Step 2 — Mechanism Video (Video Producer + Copy)
- Explains HOW the product / service works at technical level
- Video style: Premium Trust pacing — clinical, no urgency
- dependsOn: [Step 1 copy stepId]

Step 3 — Retargeting Ad (Image Producer + Copy)
- Served only to people who saved Step 1 or watched >50% of Step 2
- Dark Post style, warm audience specs
- CTA: "Book consultation" / "Request a quote"
- dependsOn: [Step 2 stepIds]

Clinical Authority Mandate (all copy steps)
- Data Over Adjectives: zero qualitative claims without quantitative anchor
- No cure / treat / permanent / guaranteed language (route through compliance sub-agent if these come up)

Minimalist Visual Mandate (all Image Producer steps)
- Premium Trust Visual sub-skill applies (in Image Producer)
- Negative space ≥40%, muted palette, cinematic lighting
- No bold primary colors, no UGC aesthetic

High-LTV Safe Zones
- No countdown timers, no strikethrough pricing, no FOMO language
- Urgency only if factually based (limited spots / genuine waitlist)

Hard Limits:
- Never use Traffic Engine visual aesthetic for Premium Trust content
- Never skip compliance hand-off when health / financial claims arise

---

## Output Format

- Funnel Classification: [Traffic Engine / Premium Trust / Barbell / Product Launch / Flash Sale] + rationale
- Scenario chosen: [A / B / C / D or mix]
- Phase structure: with timing, objective, CTA register, signal target
- Dependency chain: which steps depend on which (for parallel / serial routing)
- Channel mix: which platforms run which phase
- KPI per phase
- Step description directives ready to inject into downstream producer skills

## Defaults

- No funnel type declared → classify from product / price / audience: high-ticket+niche → Premium Trust; low-ticket+mass → Traffic Engine; mid-tier → ask user
- No timeline → default to industry standard (Launch: 14 days teaser / 3 days launch / 28 days sustain; Flash Sale: 48hr pre / 12hr peak / 12hr last chance)
- No channel mix declared → default to platform mix per funnel type (Traffic Engine: TikTok + IG Reels + XHS; Premium Trust: IG carousel + LinkedIn + email; Launch: omnichannel)

## Hard Limits

- Never plan a campaign without funnel classification — this drives every downstream choice
- Never mix Traffic Engine aesthetic into Premium Trust phases (or vice versa) — confuses brand
- Never collapse phase boundaries — if a Launch teaser reveals the product, the whole arc breaks
- Compliance hand-off: any campaign involving medical / health / financial claims routes through compliance sub-agent before generation

## Cross-Reference

- Brief Tear Down: provides the structured brief that feeds funnel classification
- Brand Soul Enforcer: locks brand parameters that the channel mix + visual style must respect
- Big Idea: chosen Creative Platform from Big Idea anchors the campaign narrative across all phases
- Content Strategy Models: provides phase-level narrative structure WITHIN a Campaign Plan phase (e.g., a single Education Carousel inside Premium Trust Funnel still uses FAB or PAS internally)
- Cross-Channel Adaptation Matrix: invoked AFTER Campaign Plan + Big Idea are locked; produces per-channel asset breakdown
- All Production skills: receive phase directives + funnel context from this skill