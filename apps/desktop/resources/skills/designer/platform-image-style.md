---
name: platform-image-style
description: Use when generating image prompts for any social media or ad platform — Instagram, Xiaohongshu (XHS / 小红书), Facebook, Pinterest, LinkedIn, Twitter/X, Snapchat, Threads, TikTok cover, or YouTube thumbnail. Returns platform-specific aspect ratio, aesthetic style, algorithm preferences, and audience signals. Single source of truth for platform image specs — never duplicate dimensions in Cross-Channel Adaptation Matrix or anywhere else.
---


# Platform Image Style

This skill produces image prompts that match each platform's native aesthetic, algorithm priorities, and audience signals. Generic high-quality photo prompts underperform on every platform in 2026 because algorithms increasingly penalize content that doesn't match platform-native style. Reference this skill any time the user names a platform.

## When to Use

Invoke when the brief contains a platform name (English or Chinese):
- instagram / ig / 图软 (rare)
- xiaohongshu / xhs / 小红书 / RED / 笔记 / 种草
- facebook / fb / meta
- pinterest / pin
- linkedin / B2B
- twitter / x.com / 推特
- snapchat / snap
- threads
- tiktok cover / tiktok thumbnail / 抖音封面
- youtube thumbnail / YT thumbnail

## Decision Logic

1. Detect named platform(s) from the brief
2. Look up the platform section below for ratio + aesthetic + algorithm + audience
3. Inject the mandatory directive into the prompt
4. Surface conflicts when user's request contradicts platform reality (e.g., "studio luxury for XHS" — explain XHS algorithm penalizes that)
5. If multiple platforms named, run a separate prompt pass per platform — never auto-crop between aspect ratios

## Platform Reference

### Instagram

- Feed ratio: 4:5 (1080×1350) preferred; 1:1 (1080×1080) acceptable; never below 4:5
- Story / Reels cover: 9:16 (1080×1920); active zone center 80%
- Aesthetic: polished, lifestyle-led, studio-lit, color-graded for grid coherence
- 2026 algorithm shift: increasingly favors native-feel over hyper-polished; ads that look like organic Reels achieve 40-60% lower effective CPMs than studio-produced ads
- Algorithm priorities: completion rate > saves > profile visits; aesthetic-coherent grids retain followers
- Audience signal: lifestyle aspiration; mobile-first scroll-with-sound-off (majority of viewing)
- Mandatory inject: "Mobile-first composition, readable at thumbnail, brand-coherent color grade, hook in first 3 seconds equivalent (visual focal point in first glance)."
- Avoid: low-resolution, mixed aesthetics within a brand grid, desktop-orientation horizontal images

### Xiaohongshu (XHS / 小红书)

- Note image: 3:4 (1080×1440) standard; 9:16 (1080×1920) for full-screen feel
- Two dominant aesthetics: 小清新 (soft pastels, natural light, airy) OR 高级感 (desaturated cool, sophisticated, premium product)
- CRITICAL authenticity rule: over-polished studio-lit images underperform; algorithm penalizes obvious advertisement; native UGC-feel preferred
- Algorithm priorities: saves > comments > likes; favors search-discovery content; long captions reinforce save behavior
- Audience signal: research-driven purchase intent (XHS = de facto search engine for lifestyle decisions in CN-speaking markets)
- Mandatory inject: "Avoid obvious advertisement aesthetic; favor authentic native feel; text rendered IN image (not overlay added later); soft natural lighting OR desaturated premium palette."
- Hard rule: zh-HK markets render Traditional Chinese; zh-CN markets render Simplified; never mix scripts
- Avoid: high-saturation studio photography, generic stock-photo aesthetic, obvious brand-billboard look

### Facebook

- Feed (single image): 1:1 (1080×1080) preferred; 1.91:1 (1200×628) acceptable
- Carousel: 1:1 all slides; slide 1 functions as standalone hook
- Stories: 9:16 (1080×1920); active zone is center 66%
- Aesthetic: direct, conversion-focused, bolder type, less aesthetic-led than IG
- Algorithm priorities: rewards engagement + ad spend signals; uses FB social graph (friends-and-family) more than discovery
- Audience signal: older skew (35+), price-comparison mindset, product-evaluation context
- Mandatory inject: "Conversion-focused composition; CTA-clear; product clearly identifiable in first glance."
- Avoid: aesthetic-only shots without product clarity, Gen-Z meme aesthetic

### Pinterest

- Standard Pin: vertical 2:3 (1000×1500) — non-negotiable for distribution
- Long Pin: 1:2.1 (1000×2100) for tutorials / recipes / how-to
- Aesthetic: aspirational lifestyle, DIY-friendly; text overlay common (recipe titles, tutorial steps)
- Algorithm priorities: long-tail discoverable via search; pins live for months not hours
- Audience signal: high-intent planning behavior (wedding, home, recipe, style, travel)
- Mandatory inject: "Vertical 2:3 composition; text overlay supporting search keywords; aspirational lifestyle framing."
- Avoid: square pins (cropped in feed), horizontal pins (de-prioritized), studio product-only shots

### LinkedIn

- Single image: 1.91:1 (1200×628) feed format
- Document Carousel: 1:1 (1080×1080) all slides; up to 20 slides
- Aesthetic: B2B professional, data-forward, infographic-friendly, restrained corporate palette
- Algorithm priorities: meaningful comments > saves > reshares (vanity metrics down-weighted)
- Audience signal: professional context, ROI-oriented, decision-makers scrolling during work hours
- Mandatory inject: "B2B professional register; data or insight forward; restrained color palette."
- Avoid: meme aesthetic, overly casual tone, lifestyle aspiration, emoji-heavy text

### Twitter / X

- Single image: 16:9 (1200×675) optimal; 1:1 also valid
- Multi-image: 1:1 grid (4 images max in one post)
- Aesthetic: news-feed style, information-dense, screenshot-friendly, low polish acceptable
- Algorithm priorities: engagement velocity in first 60 minutes; replies > retweets > likes
- Audience signal: real-time news consumption, opinion-driven, fast scroll
- Caption rule: 280 character limit; image must work even when caption is truncated
- Mandatory inject: "Information-dense; works without context caption; first-hour engagement priority."
- Avoid: aesthetic-only branding, content requiring multi-paragraph caption to parse

### Snapchat

- Stories / Spotlight: 9:16 (1080×1920); bleed image to edges
- Discover ad: 9:16 with safe zone (top 250px and bottom 250px clear of UI)
- Aesthetic: young, raw, ephemeral, AR-filter friendly, intentionally less polished
- Algorithm priorities: 24-hour content lifespan; rewards story completion + screenshots
- Audience signal: Gen Z and younger millennials, identity-first content
- Mandatory inject: "Raw aesthetic; selfie-friendly composition; ephemeral feel; AR-filter compatible."
- Avoid: highly produced brand imagery, generation-mismatched aesthetic

### Threads

- Post image: 1:1 (1080×1080) standard
- Aesthetic: casual, conversational, text-companion (image supports text); low polish acceptable
- Algorithm priorities: text-dominant feed; image serves as supporting context
- Audience signal: IG users seeking Twitter-like conversation; less performative than IG
- Mandatory inject: "Casual conversational tone; image supporting rather than leading; not heavily produced."
- Avoid: highly produced ad imagery (reads out-of-place in conversational feed)

### TikTok Cover (thumbnail for vertical video)

- Cover: 9:16 (1080×1920) vertical
- Aesthetic: high contrast, emotion-driven, bold text overlay (≤5 words), face-forward, legible at small thumbnail size
- Algorithm priorities: cover thumbnail influences first 0.3-second scroll decision; correlates with downstream completion rate
- Audience signal: scroll-fast, attention-poor, mass demographic
- Mandatory inject: "High contrast; emotion-driven; bold text overlay; readable at 25% zoom."
- Hard rule: must be legible at 320×568 (smallest size in mobile feed)

### YouTube Thumbnail

- Thumbnail: 16:9 (1280×720 minimum) horizontal
- Aesthetic: face + bold text + high contrast; eyes must be visible and emotion-readable
- Algorithm priorities: thumbnail + title combo is the SINGLE biggest CTR factor on YouTube
- Audience signal: search and recommendation-driven; longer attention span than TikTok
- Mandatory inject: "Face with visible eyes; bold text overlay; high contrast; legible at smallest player size."
- Hard rule: text legible at 320×180 (smallest size YouTube shows); for Premium Trust brand category, never clickbait expression

## Output Format

Return structured prompt with:
- Platform: [name]
- Ratio: [aspect ratio + pixel dimensions]
- Aesthetic directive: [platform style mandate]
- Algorithm-optimized framing: [inject from platform section]
- Safe-zone notes (if applicable)
- Avoid list (pulled from platform section)

## Defaults

- No platform named → flag and ask user before generating
- Multiple platforms named → run per-platform pass for each; never auto-crop
- User says "social" with no specifics → default to Instagram (EN market) or Xiaohongshu (CN market); surface assumption
- User asks platform aesthetic that contradicts reality → surface conflict and propose alternative

## Hard Limits

- Never auto-crop between aspect ratios; each platform gets its own composition pass
- Never produce "generic high-quality photo" — must produce platform-native style
- zh-HK / zh-TW markets: Traditional Chinese in rendered text
- zh-CN markets: Simplified Chinese
- Sound-off default: static images must convey full message visually
- First-screen rule: key element must be in first visible frame at platform's default crop

## Cross-Reference Other Sub-skills

- Carousel Design: multi-slide layout formulas (IG / XHS / LinkedIn carousels)
- Hook Visual: scroll-stop mechanics (paid placements pull from this table)
- Cheat Sheet / Save-Bait Layout: information-dense slide formulas (combine with platform style)
- Premium Trust Visual: high-ticket aesthetic mode (overlays on top of platform style)
- Video Cover / Thumbnail: uses TikTok cover + YouTube thumbnail specs from this table