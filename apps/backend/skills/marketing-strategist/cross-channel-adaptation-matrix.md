---
name: cross-channel-adaptation-matrix
description: Use after Big Idea is picked AND BEFORE Production skills fire. Distributes one Big Idea into a channel-by-channel matrix — which channels, how many assets per channel, what tonal adjustments per channel, what copy rewrite direction per channel. Does NOT specify ratios / pixels / specs (those are owned by Platform Image Style / Platform Video Style — single source of truth). This skill is about ALLOCATION and ADJUSTMENT, not specifications.
---


# Cross-Channel Adaptation Matrix

When a Big Idea needs to live across multiple channels (IG + XHS + TikTok + EDM + LP, say), the same idea cannot just be copy-pasted with size adjustments. Each channel has its own audience expectation, tonal convention, and content format. This skill produces the matrix that decides what shape the Big Idea takes per channel — before production fires.

Without this skill, the user has to manually figure out: "OK if I have 4 IG carousels and 8 XHS notes, should they all carry the same headline? Same visual? Or do they each get a unique angle?" That manual coordination is where multi-channel campaigns fragment.

## When to Use

Fire when:
- Brief specifies multiple channels ("IG + XHS + TikTok" / "Reels and EDM" / "multi-channel" / "多渠道")
- User asks for asset count distribution ("3 carousels + 1 video + 2 emails")
- Big Idea has been picked and downstream production involves 2+ different platforms
- Brief mentions cross-platform consistency / coherence concerns

Skip when: single-channel brief; single asset; user provides explicit per-channel asset list with adjustments (already done that manual work).

## Apply

### 1. Channel Selection

First, decide which channels are in scope. Sources of channel choice:
- User-named explicitly ("IG + XHS")
- Inferred from audience persona (where does the persona consume content?)
- Inferred from funnel (Traffic Engine → TikTok/Reels heavy; Premium Trust → IG/LinkedIn carousel + email)
- Default mix when ambiguous (surface to user for confirmation)

Do NOT mass-distribute across every channel. Each channel adds production cost — fewer channels done well > many channels done thin.

### 2. Asset Count Allocation

Per channel, decide:
- How many assets in this campaign (e.g., "4 IG carousels")
- What format (single image / carousel / story / Reel / long-video / email / LP)
- What funnel role per asset (top-of-funnel awareness / mid-funnel education / bottom-funnel conversion)

Guide-rails for asset count per channel (per typical campaign):
- IG feed: 3-5 (more dilutes the grid)
- IG Stories: 5-10 (ephemeral, higher tolerance)
- XHS notes: 5-10 (algorithm rewards consistent posting)
- TikTok / Reels: 2-4 (production cost high; quality > volume)
- LinkedIn: 1-3 (audience tolerance for ad fatigue is LOW)
- Email: 1-3 in a campaign sequence
- LP: 1 (more than 1 LP for same campaign = analytics confusion)

### 3. Tonal Adjustment Per Channel

The same Big Idea / Tagline lands differently per channel. Define adjustments:

| Channel | Default tonal adjustment |
|---|---|
| Instagram | Polished, aesthetic-led, lifestyle aspiration |
| Xiaohongshu | Authentic, native, conversational, "friend-recommending" tone |
| Facebook | Direct, conversion-focused, slightly bolder than IG |
| TikTok | Raw, native, UGC-feel, pattern-interrupt energy |
| Reels | Aesthetic + sound-on, native-not-commercial |
| YouTube | Storytelling-tolerant, longer attention spans |
| LinkedIn | B2B professional, data-forward, restrained |
| Email | Personal-feeling, one-to-one register, longer-form OK |
| Landing Page | Conversion-focused, benefit-led, scannable |

For each in-scope channel, write a 1-sentence tonal adjustment for THIS campaign. Don't just list "polished" — write what polished means for this Big Idea on this channel.

### 4. Copy Rewrite Direction Per Channel

The Tagline / headline carries across, but the copy AROUND it changes:

- IG caption: longer-form (125-150 words), lifestyle storytelling angle
- XHS 笔记 body: 800+ chars, 推荐她 / 亲身体验 tone, save-bait structure
- TikTok caption: short (≤100 chars), keyword-trigger CTA
- Reels caption: medium (80-150 chars), question hook
- LinkedIn post: 150-300 words, opinion / insight angle, professional voice
- Email body: personal salutation, conversational flow, one clear CTA
- LP copy: feature-benefit translation, trust signals, multiple CTAs

For each in-scope channel, specify the copy rewrite angle (not the actual copy — that's Ad Copywriting / Editorial Content's job downstream).

### 5. Hero Asset / Hero Channel Designation

Which asset is the hero of the campaign? Every campaign needs one piece that's the canonical expression of the Big Idea; everything else adapts from it.

- Usually: the highest-investment asset (typically the video or the lead carousel)
- All other adaptations reference the hero ("hero carousel slide 1 carried as IG single image; hero video frame 0:15 used as XHS thumbnail")

### 6. Output Format — The Matrix


## Cross-Channel Adaptation Matrix — [Campaign Name / Big Idea]

### Channel Allocation
| Channel | Count | Format | Funnel role | Hero? |
|---|---|---|---|---|
| Instagram | 4 | Carousel | MOF education | ✅ (Slide 1 = hero) |
| XHS | 8 | Note | TOF discovery + MOF | |
| TikTok | 3 | Reel | TOF awareness | |
| EDM | 2 | Email sequence | BOF conversion | |
| LP | 1 | Sales page | BOF conversion | |

### Per-Channel Tonal Adjustment
- **Instagram**: [specific tonal direction for this Big Idea on IG]
- **XHS**: [specific direction for XHS]
- [...continue per channel]

### Per-Channel Copy Direction
- **Instagram caption**: [angle + length + CTA type]
- **XHS 笔记**: [angle + length + tone + CTA]
- [...continue per channel]

### Hero Asset
[Which asset is the canonical hero; what other assets adapt from it]

### Cross-Channel Coherence Check
- Tagline carries consistently across all channels? Yes / [adjusted: ...]
- Visual mood (palette / texture from Mood Board) carries consistently? Yes / [adjusted: ...]
- Big Idea Creative Platform expressed at every channel? Yes / [flag: ...]


## Defaults

- No channels declared → infer from audience persona's behavioral patterns (where do they actually consume?); surface for confirmation
- No asset counts declared → use guide-rails per channel from §2; surface
- No hero asset specified → designate by production cost / investment (typically video or lead carousel)
- Channel mix is too wide (≥6 channels) → flag risk of production thin-ness; propose dropping low-priority channels

## Hard Limits

- NEVER specify ratios / pixel dimensions / file specs — those are owned by Platform Image Style and Platform Video Style (single source of truth)
- NEVER specify visual style details (palette, lighting, composition) — those come from Mood Board
- Never auto-crop one channel's asset into another's — each channel asset is a separate production pass
- Never let Tagline shift between channels — caption / copy ADAPTS, but the headline / tagline carries verbatim for brand recall
- Hero asset must exist — if no hero, the campaign reads as disconnected pieces

## Cross-Reference

- Big Idea: provides the Creative Platform + Tagline that this skill distributes across channels
- Mood Board: provides the visual world that production skills use; this skill does not duplicate visual specs
- Platform Image Style / Platform Video Style (Image Producer / Video Producer): owns the ratio / size / aesthetic specs; this skill REFERENCES them, never duplicates
- Campaign Plan: provides the funnel + phase context that drives funnel-role allocation per asset
- Ad Copywriting / Editorial Content / Email Copy: receives the per-channel copy DIRECTION from this skill; they write the actual copy