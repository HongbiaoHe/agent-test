---
name: big-idea-concept-pitching
description: Use after Brief Tear Down clears and BEFORE any production skill fires. Produces 3 distinct creative concept routes (not variations of one idea), each with: concept name, central insight, 1-line creative platform, 3 tagline candidates, key visual direction, and tone notes. User picks 1 route; selected concept anchors downstream Production. This is the creative agency's "3 routes" pitch model adapted for AI agent.
---


# Big Idea / Concept Pitching

In real creative agencies, the creative team never proposes one idea — they pitch 3 distinct routes to give the client meaningful choice. Each route should explore a fundamentally different creative territory (consumer insight / category disruption / cultural lever), not three flavors of the same idea. This skill produces that 3-route pitch.

Without this skill, the agent jumps from brief to production, which means the user never gets to shape direction — they only see the final output and have to react. Real creative work requires upstream choice.

## When to Use

Fire AFTER Brief Tear Down confirms a brief, and BEFORE any Production skill (Image Producer / Video Producer / Ad Copywriting / Editorial Content). Trigger criteria:

- The user explicitly asks for concepts / ideas / directions (give me 3 directions, 三个创意)
- The user's brief is mid-to-low specificity (e.g., "do a TikTok for our new matcha" — no concept defined yet)
- The brief involves brand campaign / Big Idea / launch — any moment where direction has not been pre-decided

Skip this skill when:
- User provides a complete storyboard / image prompt / detailed concept (creative direction already locked)
- User says "just generate, no need to pitch" (opt-out)
- The task is purely production (e.g., "resize this image for IG Story")

## Apply

### 1. Map the 4Cs (silent step before generating routes)

Before generating concepts, internally extract:

- Consumer: What drives them emotionally? What's the unmet need? (from Audience Persona / brief)
- Category: What's the competitive gap? What is everyone in the category saying that we can NOT say?
- Culture: What cultural shift, mood, or moment is relevant right now?
- Company: What's authentic to this brand? What can they own that competitors can't?

Each of the 3 routes should pull from a DIFFERENT C as its primary driver. This is what creates genuine differentiation — not three taglines about the same insight.

### 2. Build 3 Distinct Concept Routes

Each route follows the same structure but explores fundamentally different territory:

Route Structure:


### Route [N]: [Concept Name]

**Primary driver**: [Consumer insight / Category disruption / Cultural moment / Company truth]

**Central insight**: [One sentence — the truth this concept rests on]

**Creative platform**: [One sentence — the springboard that can extend across ads, packaging, social, video, etc.]

**Tagline candidates**:
1. [Short, memorable, ≤7 words]
2. [Alternative tone]
3. [Alternative angle]

**Key visual direction**: [What the hero image / opening frame looks like]

**Tone / voice**: [Personality — e.g., confident-restrained, playful-conspiratorial, clinical-authoritative]

**Why this route**: [One sentence — what business outcome this creates]

**Risk / trade-off**: [One sentence — what this route gives up vs the others]


### 3. Differentiation Test (silent quality check)

Before presenting, verify the 3 routes are truly distinct:

- Can you swap tagline 1 from Route A into Route B without it feeling wrong? → if YES, routes are too similar; rewrite one
- Do the 3 routes pull from different Cs (Consumer / Category / Culture / Company)? → if all from same C, rewrite
- Could the same hero image serve all 3 routes? → if YES, they're not visually distinct; rewrite key visuals

### 4. Tagline Quality Standards

Each tagline must meet:

- Length: ≤7 words (memorable threshold; longer taglines don't get repeated)
- Ownability: Could a direct competitor say the exact same line? If yes, fail.
- Specificity: Avoid abstract virtue words ("quality / passion / innovation")
- Sound test: Read aloud — does it have rhythm or surprise? Generic lines lose this test
- Translation tolerance (if zh-HK / zh-CN market): does it survive translation, or is the wordplay locked to English?

### 5. Platform Idea vs Tagline (advanced)

For brand-level Big Ideas (not single-campaign), aim for platform ideas — expansive creative springboards that can extend across:
- Ads (multiple executions)
- Packaging copy
- Retail / event activations
- PR moments
- Social campaigns spanning months

A tagline alone ("Just Do It") is the SURFACE of a platform idea (Nike's: athletic potential is in everyone, regardless of skill). When the brief is brand-level, mark the route's Creative Platform as the platform idea, with the tagline as one expression of it.

### 6. Presenting to User

Output format for user consumption:


## 3 Creative Routes for [Brief Description]

Each route explores a different territory. Pick one to proceed; we'll build production around your choice.

[Route 1 — with structure from §2]

[Route 2 — with structure from §2]

[Route 3 — with structure from §2]

**Quick comparison:**
| | Route 1 | Route 2 | Route 3 |
|---|---|---|---|
| Driver | [C] | [C] | [C] |
| Tone | [...] | [...] | [...] |
| Best for | [scenario] | [scenario] | [scenario] |

**My recommendation**: Route [N] — [one-sentence rationale based on brief constraints]. But the choice is yours — each route can be production-ready.


## Output Format

- 3 Route briefs (each with: name, driver, insight, platform, 3 taglines, visual direction, tone, why-this, trade-off)
- Comparison table (driver / tone / best-for, one row per route)
- Recommendation with rationale (do NOT skip — user wants opinionated direction, not 3 equal options to wade through)
- Next step prompt for user ("pick a route and I'll route to production")

## Defaults

- Always produce exactly 3 routes — not 2, not 5. 3 is the industry standard (enough variety, not overwhelming)
- Always provide a recommendation — users hate "all three are great"; pick one with reason
- If brief has hard constraint that eliminates a route type → surface and reduce to 2 routes with explanation
- If user rejects all 3 routes → ask what didn't land (territory? tone? insight?) and produce 3 new routes pivoting on that dimension

## Hard Limits

- Never produce 3 variations of the same idea — each route must pull from a different 4Cs lever
- Never lead with the recommendation — user sees 3 routes first, recommendation comes after; otherwise it biases their choice
- Never propose taglines >7 words — unmemorable, won't be used
- Never use virtue words (passion / quality / innovation / excellence) in taglines — these say nothing
- Never proceed to production until user picks a route — if user says "just go with your favorite," pick the recommendation and explicitly confirm before generating

## Cross-Reference

- Brief Tear Down: must run BEFORE this skill; provides the 8-field structured brief that feeds the 4Cs mapping
- Market Discovery: if 4Cs mapping reveals missing category/culture intel, run Market Discovery first
- Brand Positioning: if the brand has no defined position (0→1 brand), positioning happens BEFORE Big Idea
- Mood Board: invoked AFTER user picks a route — the chosen route's visual direction feeds Mood Board
- All Production skills: invoked AFTER user picks a route; the chosen Creative Platform + Tagline + Key Visual carry into Image / Video / Copy production

## Handoff Contract

After the user picks one of the 3 routes, `content-strategy-models` reads the following **4 fields** from the selected route as **coloring inputs** for downstream image / video / copy production:

- **driver** — exactly one C (Consumer / Category / Culture / Company), not "Consumer + Culture"
- **central insight** — one sentence, concrete and quotable
- **tone / voice** — a named register ("confident-restrained", "calm-observational", "playful-conspiratorial"), not vague adjectives like "engaging" or "modern"
- **key visual direction** — 2-3 concrete elements (palette / framing / subject), not a paragraph of vibes

These 4 fields must be written with enough specificity that a downstream agent can mechanically apply them. Avoid abstract adjectives; name concrete vocabulary.

The remaining fields (concept name, taglines, creative platform, why-this, risk / trade-off) are NOT consumed by `content-strategy-models`. They serve user choice and downstream copywriter / mood-board independently.