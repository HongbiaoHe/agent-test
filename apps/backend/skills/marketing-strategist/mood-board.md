---
name: mood-board
description: Use after a Big Idea route is picked and BEFORE Image Producer / Video Producer fires. Produces a text-only visual direction board — color palette (with hex codes), texture / material vocabulary, typography direction, lighting mood, composition references, and keyword vocabulary list. Does NOT generate images (saves AI image-gen credits). Locks visual direction so all downstream production reads as one coherent campaign rather than disconnected outputs.
---


# Mood Board (Text Only)

This skill produces a text-only visual direction document that anchors all downstream image / video production in one campaign. The traditional mood board in design agencies is a Pinterest-style image collage — we don't generate that here (would burn AI image-gen credits before production has even started). Instead, we produce a structured text artifact that describes the visual world precisely enough that any downstream producer skill can pull from it.

Why this matters: without a mood board, each downstream image / video gets generated against different vibes — you get 5 carousel slides that don't feel like one campaign. The mood board locks the world.

## When to Use

Fire AFTER Big Idea is chosen by user AND BEFORE any Image Producer / Video Producer skill fires. Triggers:
- User picks a Big Idea route
- User asks for "visual direction" / "视觉方向" / "调性" / "美术方向"
- Multi-asset campaign (3+ assets) where visual coherence matters
- Brand campaign without existing brand visual identity

Skip when: single one-off asset (no coherence needed); user has uploaded reference images (Brand Reference Asset Inject handles those directly); existing brand has locked visual guidelines (Brand Soul Enforcer takes over).

## Apply

### 1. Color Palette

Define the campaign palette as hex codes:

- Primary (1 color): the dominant brand-recognizable color, used in 50-60% of pixel area
- Secondary (1-2 colors): supporting tones, used in 25-35%
- Accent (1 color): reserved for CTA / data highlights, used in 5-10%
- Neutral (1-2): backgrounds, type, negative space

For each, include:
- Hex code (e.g., #3E2723)
- Named description (e.g., "deep espresso brown")
- Use rule (e.g., "primary for background and product, accent for CTA button only")

If Brand Soul Enforcer is active, pull palette from there (do not invent new). If 0→1 brand, propose palette and surface for user confirmation.

### 2. Texture / Material Vocabulary

List the surfaces and materials present in the visual world. Specificity > virtue words:

- ❌ "premium, luxurious"
- ✅ "raw linen / matte ceramic / brushed brass / weathered Provence stone"

Goal: 5-8 specific materials that signal the campaign's tactile reality. Production skills use these to anchor texture in image prompts.

### 3. Lighting Mood

Define the lighting world:
- Type: natural daylight / golden hour / cinematic single-source / overcast / studio soft / harsh direct
- Color temperature: warm (2800-3200K) / neutral (4000-5000K) / cool (5600K+)
- Direction: front / side / back / overhead / window-light
- Quality: soft / hard / dappled / specular
- Time of day implication: morning calm / midday energy / golden hour intimacy / dusk premium

Downstream Image Producer / Video Producer skills use this exactly to lock lighting prompts.

### 4. Typography Direction (if rendered text in image)

- Display weight: e.g., "editorial serif, light to medium weight, generous letter-spacing"
- Body weight: e.g., "clean sans-serif, regular weight"
- Tone: "considered, restrained" vs "loud, attention-grabbing"
- Hierarchy: how display vs body relate visually

If brand has declared typefaces (via Brand Soul Enforcer), pull from there. If not, describe direction (specific typefaces are downstream production decision).

### 5. Composition References

Describe how the visual frame is composed:
- Negative space: how much breathing room (Premium Trust: ≥40%; Traffic Engine: ≥25%)
- Subject placement: rule-of-thirds / centered / off-center / asymmetric tension
- Depth: shallow DoF / deep focus / flat 2D
- Camera height / angle: eye-level / overhead / low / Dutch tilt
- Framing: tight crop / mid-shot / wide / environmental

### 6. Keyword Vocabulary List

Produce 10-15 keywords that downstream Image / Video producer skills can directly inject into prompts. Mix:
- Atmosphere words: "intimate, considered, unhurried, gathering, ritual"
- Material words: "linen, ceramic, brass, paper, wood-grain"
- Light words: "golden, soft-overhead, side-light, low-key, ambient"
- Mood words: "warm-grounded, quietly-confident, hand-made"
- Avoid words: "clinical, sterile, mass-market, generic, stock"

These keywords are the shared vocabulary that links the campaign — every downstream production skill should pull from this list.

## Output Format


## Mood Board — [Campaign / Big Idea Name]

### Color Palette
| Role | Hex | Named | Use rule |
|---|---|---|---|
| Primary | #... | ... | ... |
| Secondary | #... | ... | ... |
| Accent | #... | ... | ... |
| Neutral | #... | ... | ... |

### Texture / Material Vocabulary
- [5-8 specific materials]

### Lighting Mood
- Type: [...]
- Color temperature: [...]
- Direction: [...]
- Quality: [...]
- Implication: [...]

### Typography Direction
- Display: [...]
- Body: [...]
- Tone: [...]

### Composition References
- Negative space: [...]
- Placement: [...]
- Depth: [...]
- Camera: [...]
- Framing: [...]

### Keyword Vocabulary
**Use these in production prompts:**
[10-15 keywords listed]

**Avoid these:**
[5-8 anti-pattern keywords]

### Cross-Campaign Consistency Note
All Image Producer / Video Producer outputs for this campaign must pull from this vocabulary. Color palette is locked — do not introduce other hex codes. Lighting mood is locked across all 5+ assets to read as one campaign.


## Defaults

- No palette guidance from user → propose palette aligned with Brand Soul Enforcer (if active) or Big Idea's chosen route mood; surface for confirmation
- No texture vocabulary from user → derive 5-8 from Big Idea's Creative Platform direction
- No lighting mood from user → derive from Status Level (Level 4-5 → cinematic single-source; Level 2-3 → natural daylight; Traffic Engine → high-contrast / handheld)
- No typography guidance → if Brand Soul Enforcer is active, pull from there; else describe direction generically

## Hard Limits

- Text-only — do NOT generate images — the whole point of this skill is to lock direction BEFORE production burns image-gen credits
- Hex codes are exact — do not write "approximate" colors; pick specific hex values
- Material vocabulary must be specific — "premium materials" fails; "raw linen, brushed brass, paper-grain" passes
- Keyword vocabulary must be unique to campaign — if the keywords could apply to any beauty campaign, they're not anchoring this campaign
- Avoid virtue words — "luxurious / premium / authentic" are placeholders, not descriptions

## Cross-Reference

- Big Idea: chosen Creative Platform feeds the mood; the mood expresses the Big Idea visually
- Brand Soul Enforcer: provides existing brand palette / typography / imagery standard that constrains Mood Board
- Brand Reference Asset Inject (Image Producer): if user has uploaded reference images, those become anchor points; Mood Board complements (not replaces) those
- Platform Image Style (Image Producer): Mood Board defines the universal visual world; Platform Image Style adapts that world to platform-specific aesthetic + spec
- Platform Video Style (Video Producer): same as above for video
- All Production skills: pull keyword vocabulary from this skill's output