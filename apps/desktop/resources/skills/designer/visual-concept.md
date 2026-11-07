---
name: visual-concept
description: Use when generating an image prompt that needs a specific layout / aesthetic formula — not just a generic image. Five scenario branches in body: Carousel Design (slide-based information layout), Hook Visual (scroll-stop mechanics for paid / organic), Cheat Sheet / Save-Bait Layout (information-dense infographic), Premium Trust Visual (luxury / high-ticket aesthetic), Video Cover / Thumbnail (cover-frame formula). Combine with Platform Image Style (provides platform-specific specs + aesthetic) for full image prompt.
---


# Visual Concept

This skill provides layout and aesthetic formulas for image generation. These are orthogonal to platform style — a Carousel on IG looks different from a Carousel on XHS; a Cheat Sheet on LinkedIn looks different from a Cheat Sheet on Pinterest. This skill picks the right formula; Platform Image Style applies the platform expression.

Mental model: Visual Concept = WHAT type of visual to make (format / aesthetic). Platform Image Style = HOW to express it on a specific platform (specs / native style).

## When to Use

Fire when the brief calls for a specific visual format or aesthetic mode:

- carousel / 轮播图 / 图辑 / multi-slide content
- hook visual / scroll-stopper / 吸睛 / first-frame attention
- infographic / cheat sheet / 干货图 / 信息图
- luxury / premium / 高端 / 医美 / high-ticket aesthetic
- cover / thumbnail / 封面 / video cover frame

Skip when: brief specifies only platform without format (route directly to Platform Image Style); user has uploaded complete reference visual (Brand Reference Asset Inject takes over).

## Decision Logic

1. Detect format / aesthetic keyword from brief
2. Select scenario branch (one of the 5 below)
3. Combine with Platform Image Style for the platform-specific expression
4. If multiple formats requested (e.g., "carousel + cover"), run multiple passes

## Apply

### Scenario A — Carousel Design

Multi-slide image content. Slide 1 functions as standalone hook (must work even if user doesn't swipe).

Information Architecture:
- Slide 1 (Hook / Cover): the standalone scroll-stop; carries the Big Idea / question / contradiction
- Slides 2 to N-1 (Body): progressive reveal of the value; each slide advances by exactly one beat (no two slides making the same point)
- Final Slide (CTA): action verb + value; never a generic "link in bio"

Per-slide composition:
- 1 key insight per panel — not 2, not 3
- 40% text / 60% visual minimum (text-heavy panels lose mobile readers)
- Typographic hierarchy: Primary ≥36px / Secondary ≥24px / Body ≥18px (designed for mobile viewing at thumb-distance)
- Max 2 typefaces per asset (display + body)

Directional cues (keep eye moving across slides):
- Numbered sequences (1–2–3...)
- Arrows or color progression
- Subject gaze direction pointing toward next slide

Carousel platform variations:
- Instagram carousel: visual-first, minimal text per slide (≤3 words on cover); aesthetic-coherent color grade across all slides
- Xiaohongshu 图辑: text is primary, visual secondary; designed as graphic poster, not photography; text rendered in-image (not as overlay added later); zh-HK Traditional / zh-CN Simplified strict
- LinkedIn Document carousel: B2B professional; data-forward; restrained palette; up to 20 slides; designed for desktop save / share
- Facebook carousel: 1:1 all slides; slide 1 hook = standalone

### Scenario B — Hook Visual (Scroll-Stop)

Scroll-stop hook for ad creatives and high-velocity organic. Choose ONE scroll-stop mechanism per asset.

4 Scroll-Stop Mechanisms (pick one based on audience temperature):

| Mechanism | Definition | Best for |
|---|---|---|
| A. High Contrast | Subject-to-background ≥7:1 luminance ratio | Cold audiences, fast-scroll feeds |
| B. Pattern Interrupt | Unexpected visual for this category context | Warm audiences who scroll past familiar imagery |
| C. Visual Tension | Incomplete composition; eye cannot rest; off-balance | Warm audiences, premium brand context |
| D. Text Shock | Data point or statement rendered large as the hero | Educational / informational, high-information products |

Audience temperature → mechanism:
- Cold: A (High Contrast) or B (Pattern Interrupt)
- Warm: B or C (Visual Tension)
- Hot / retargeting: PROOF-LED (before/after, data, testimonial visual)

Zone-based composition (where things go in the frame):
- Zone 1 (top-left to top-center): hook text or focal element; largest visual weight
- Zone 2 (center): subject / mechanism / product hero
- Zone 3 (bottom): CTA, brand element, secondary text
- Dead zones (corners): minimal info; safe for logo placement

Aesthetic mode (for organic Hook Visual):
- UGC-Native: handheld feel, natural lighting, bold primary colors, casual composition
- Polished-Accessible: clean but energetic, brand colors at full saturation

Paid Hook Visual placement specs (pull from Platform Image Style for exact ratios):
- IG Feed 4:5 / FB Feed 1:1 / Stories or Reels 9:16 / LinkedIn 1.91:1 or 1:1
- Max 3 text elements per ad asset; text coverage <20% of canvas

Human subject rule:
- Eyes / body language pointing toward Zone 1 (hook) or Zone 3 (CTA)
- Natural skin texture ("photorealistic skin, visible pores, natural micro-expressions")

### Scenario C — Cheat Sheet / Save-Bait Layout

High save-rate infographic content. Goal: viewer saves the image to refer back to.

Choose ONE layout type:

| Layout | Definition | Best for |
|---|---|---|
| Numbered List | Sequential steps, each in own panel | Tutorials, how-to, process |
| Comparison Grid | Side-by-side compare (Old way vs New way; A vs B) | Differentiation, decision-aid |
| Anatomy Map | Subject in center, labels pointing to parts | Product breakdown, anatomy |
| Timeline | Linear progression with dates / steps | History, projections, milestones |
| Icon Grid | 6-12 small icons with brief labels | Feature overviews, category maps |

Information density rules:
- 1 key insight per panel (not 2 or 3)
- 40% text / 60% visual minimum
- Bold numbers for visual hierarchy (numbers stop scroll better than words)
- Each panel scannable in ≤5 seconds

Typographic hierarchy (same as Carousel):
- Primary ≥36px / Secondary ≥24px / Body ≥18px
- Max 2 typefaces

Directional cues:
- Numbered sequences
- Arrows or color progression
- Human gaze leads to key data

Final slide CTA (for save-bait specifically):
- Brand color dominant
- Negative space ≥50%
- Single CTA text only (no multi-option)

Save-bait optimization: target Save Rate >3.5% on Instagram (this is the algorithm signal that this format reads as "information worth keeping").

### Scenario D — Premium Trust Visual

For luxury, high-ticket, medical-aesthetic, B2B premium brands. Uses 3 visual markers.

3 Premium Visual Markers (all 3 must be present):

1. Negative space ≥40% of frame intentionally empty
2. Color palette desaturated (-5 to -10% saturation), cool temperature (-5 to -8K shift), max 3 colors
3. Lighting: cinematic single-source or Rembrandt lighting; no harsh flash; no flat even lighting

Typographic restraint:
- Max 2 typefaces; display weight ≥600 for single headline; body weight ≤400
- Fewer words = more premium signal
- Data point treatment: large, isolated, high contrast — data as design

Subject treatment:
- Product: environmental context, not isolated on white; material texture is the story (not glossy product-shot mode)
- Person: editorial framing; model looks away from camera (not direct gaze); aspirational environment
- Data: single metric, enormous, surrounded by negative space

Funnel stage adaptation:
- TOF: visual shock through elegance; one image, minimal or no words
- MOF: structured minimalism; data or mechanism as visual content
- BOF: subtle urgency; proof point + CTA in elegant register (no garish red CTA buttons)

Directional cues — subtle:
- Geometric lines, lighting gradients, gaze direction
- No arrows, no bold call-out boxes; journey feels discovered

### Scenario E — Video Cover / Thumbnail

The cover frame is the standalone scroll-stop for a video. Must work even if viewer doesn't play the video.

Ratio by platform (pull exact pixels from Platform Image Style):
- YouTube: 16:9 (1920×1080)
- IG Reels cover: 1:1 (1080×1080) for grid display
- TikTok cover: 9:16 (1080×1920)
- YouTube Shorts: 9:16 (1080×1920)

Thumbnail Legibility Rule:
- Must communicate core value at 25% of full size (mobile feed thumbnail)
- Max 5 words of text; under 3 words is stronger
- If hook text not readable at 25% zoom → increase size or weight

Emotional Frame Selection (choose one):
- Problem-state: cooler temperature, tension in composition, frustration expression
- Solution-state: warmer temperature, open body language, relief expression
- Aspiration-state: aspirational environment, elevated lifestyle, slight overexposure (cinematic)

Human Subject Rules (high-CTR thumbnails almost always have a face):
- Eyes visible and directed toward camera or hook text
- Specify in prompt: "photorealistic skin texture, visible pores, natural lighting, no airbrushing"
- YouTube: direct eye contact for higher CTR
- TikTok cover: emotion-forward expression (surprise / curiosity / delight)

Text Overlay:
- Position: top-center or left-center (high-attention zone)
- Weight: Bold / Black (≥700 weight); high contrast against background
- Hook condensed to ≤5 words; numbers perform well

## Output Format


## Visual Concept Selection

### Format chosen
[Carousel / Hook Visual / Cheat Sheet / Premium Trust / Video Cover]

### Formula applied
[Specific formula details per scenario above]

### Combined with Platform Image Style
[Reference — the platform spec to pull from]

### Output prompt structure
[Layout + composition + text + subject + style directives ready for designer downstream]


## Defaults

- No format specified by user → infer from brief context (educational → Cheat Sheet; ad → Hook Visual; premium brand → Premium Trust Visual)
- No layout type for Cheat Sheet → default to Numbered List (most universal)
- No scroll-stop mechanism for Hook Visual → default to High Contrast (most defensive)
- No emotional frame for Video Cover → default to Problem-state (highest CTR for most categories)

## Hard Limits

- Never combine 2 scroll-stop mechanisms in one Hook Visual — they cancel each other
- Never use Premium Trust formula for Traffic Engine assets (vice versa); these aesthetics are opposed
- Save-bait Cheat Sheet must have >50% negative space on final CTA slide — dense final slide loses save
- Video Cover must be legible at 25% zoom — if can't read at thumbnail size, scrap and redo
- zh-HK / zh-TW markets: Traditional Chinese in any rendered text
- zh-CN markets: Simplified Chinese
- Max 2 typefaces per asset (display + body); never 3+

## Cross-Reference

- Platform Image Style (designer): provides PLATFORM SPECS (ratio / pixels) and PLATFORM AESTHETIC; this skill provides FORMAT / LAYOUT. Combine them.
- Brand Reference Asset Inject (designer): when user uploads product / model / palette, those inject into the Visual Concept output
- Mood Board (Marketing): provides palette / texture / lighting vocabulary that this skill pulls from
- Brand Soul Enforcer: visual lock constraints (palette / typography / status floor) apply on top of Visual Concept output
- Big Idea: chosen Creative Platform direction informs which Scenario to select (cinematic concept → Premium Trust; educational concept → Cheat Sheet)