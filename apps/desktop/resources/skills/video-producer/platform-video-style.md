---
name: platform-video-style
description: Use when a video task mentions ANY platform — TikTok, Instagram Reels, YouTube Shorts / Pre-roll / long-form, Facebook Reels, Snapchat Spotlight, 抖音 Douyin, 视频号 WeChat Channels, B站 Bilibili, 小红书 XHS, LinkedIn. Returns the OUTER frame length sweet-spot, pacing, hook structure, aesthetic, algorithm priorities. Also triggers on short-form, 9:16, pre-roll, in-feed, native ad.
---


# Platform Video Style

This skill produces video prompts that match each platform's native pacing, length, hook structure, and algorithm priorities. In 2026, 71% of whether viewers continue watching is determined in the first 3 seconds — platform-specific pacing is the single biggest creative factor. Generic "cinematic video" prompts underperform on every short-form platform because the algorithms favor native content over commercial production.

## When to Use

Invoke when the brief contains a platform name (English or Chinese):
- tiktok (Douyin is separate, see below)
- reels / ig reels / instagram reels
- shorts / youtube shorts / yt shorts
- pre-roll / bumper / youtube ad / 6s / 15s / 30s ad
- youtube / long-form / 长视频
- facebook reels / fb reels
- snapchat / snap spotlight
- 抖音 / douyin (CN platform, distinct from TikTok)
- 视频号 / wechat channels / 微信视频号
- bilibili / B站
- xhs video / 小红书视频
- linkedin video / linkedin reels / B2B video

## Decision Logic

1. Detect named platform(s) from the brief
2. Look up the platform section below for spec + length + pacing + hook + style
3. Inject mandatory directives into the prompt
4. Surface conflicts when user's request contradicts platform reality (e.g., "30s TikTok cinematic ad" — cinematic slow-build conflicts with TikTok 1.5s pattern interrupt; propose either shorter or reframe as YouTube)
5. If multiple platforms named, run separate prompt pass per platform — never re-cut between platforms

## Platform Reference

### TikTok

- Spec: 9:16 (1080×1920), MP4/MOV, ≤287MB
- Length sweet-spot: 15-30s for conversion ads; 21-34s algorithm-favored window for organic; 60s in-app max; 60min upload max
- Hook structure: 71% of continued-watch decision in first 3 seconds; introduce core proposition by second 3; three-part structure: hook → body → close
- Pacing: pattern interrupt every 1.0-1.5s; first 0.3s must thumb-stop
- Style: raw, native, UGC-feel; handheld OK; native creator-style outperforms polished commercial-style by wide margin; bold text overlay supported
- Algorithm priorities: completion rate > replays > shares; trending audio actively pushed to engaged users; native creators favored over re-uploads with watermarks
- Mandatory inject: "Open with hook (no logo, no slogan, no greeting); 3-second core message; trending audio compatible; native UGC aesthetic; pattern interrupt every 1.5s."
- Hard rules: never auto-crop from another aspect ratio; never open with logo / slogan / "Hi guys"
- Refresh rule: 3-5 creative variants per ad group; refresh when delivery declines

### Instagram Reels

- Spec: 9:16 (1080×1920), MP4, ≤4GB
- Length sweet-spot: <60s for Explore feed boost; up to 20 min max
- Hook structure: aesthetic establishing shot acceptable in first 1s; payoff by 3s
- Pacing: medium-fast, smoother than TikTok; allows aesthetic-moment pauses
- Style: aesthetic-led, brand-coherent, color-graded; 2026 algorithm shift increasingly favors native-feel — ads that look like organic Reels achieve 40-60% lower effective CPMs than studio-produced spots
- Sound design: Meta's data shows sound-on Reels ads outperform silent by 35% in engagement; design for sound-on
- Algorithm priorities: completion rate > saves > profile visits > shares
- Mandatory inject: "Aesthetic-coherent color grade; sound-on design; native-feel pacing (not commercial-polished); mobile-first composition."
- Hard rule: no TikTok watermarks (algorithm de-boosts cross-posted content)

### YouTube Shorts

- Spec: 9:16 (1080×1920), MP4
- Length max: 3 min (longest among major short-form; allows storytelling)
- Hook structure: more forgiving than TikTok; up to 5s hook acceptable; setup → build → payoff structure tolerated
- Pacing: storytelling tolerable; medium pace
- Style: more produced than TikTok; B-roll, motion graphics, horizontal source with letterbox all valid
- Algorithm priorities: swipe-through completion > comments > subscribers; recommendation engine carries weight
- Audience signal: YouTube search/recommendation users entering Shorts surface (often longer attention than TikTok)
- Mandatory inject: "Storytelling structure permitted; production polish acceptable; first 5s hook; clear payoff arc."

### YouTube Pre-roll Ad

- 6s bumper: 16:9 (1920×1080) or 9:16; non-skippable; exactly 1 idea — single message, single visual, brand frame at end
- 15s skippable: skip button appears at 5s; deliver core value in first 5 seconds or lose viewer; structure: hook (0-3s) → message (3-12s) → CTA (12-15s)
- 30s non-skippable: full mini-story arc; problem → solution → CTA structured like TV ad
- Mandatory inject (6s): "Single message; single visual; brand frame final 1.5s; no multi-message attempts."
- Mandatory inject (15s): "Hook in 0-3s; expect skip at 5s; core value delivered before second 5; CTA final 3s."
- Mandatory inject (30s): "Full ad arc — problem (0-8s) / solution (8-22s) / CTA (22-30s)."
- Hard rule: never load 30s structure into 15s slot or 15s structure into 6s slot — each length has distinct architecture

### YouTube Long-form (3-10 min)

- Spec: 16:9 (1920×1080) preferred; 4K accepted
- Pacing: chapter-based; slower hook tolerance (up to 15s); audience commits to watch
- Hook structure: TLDR or value preview in first 30s, then deeper dive
- Style: produced, edited; B-roll, talking-head, screen-recording all valid
- Algorithm priorities: watch time + session time + end-screen clicks; title + thumbnail combo = CTR; suggested-video sidebar drives discovery
- Audience signal: search-driven, education-mode, willing to invest attention
- Mandatory inject: "TLDR preview in first 30s; chapter structure; suggested-video bait at end."

### Facebook Reels

- Spec: 9:16 (1080×1920)
- Length sweet-spot: ≤90s
- Pacing: slower than TikTok; similar to IG Reels but with older audience
- Style: storytelling-friendly; character-led works well
- Audience signal: older skew (35+); leverages FB social graph more than algorithm discovery
- Algorithm priorities: friends-and-family signal significant; engagement velocity matters
- Mandatory inject: "Older audience register; storytelling-friendly pacing; clear product / value identification."

### Snapchat Spotlight

- Spec: 9:16 (1080×1920), <60s
- Style: AR / filter-friendly; casual; ephemeral feel; selfie / first-person POV works
- Audience signal: Gen Z heavy; identity-first content
- Algorithm priorities: rewards completion + screenshot rate; ephemeral discovery (24-hour decay)
- Mandatory inject: "Raw selfie-friendly aesthetic; AR-filter compatible; ephemeral feel; Gen Z register."

### 抖音 (Douyin)

- Spec: 9:16 (1080×1920)
- Length sweet-spot: 30-60s (CN algorithm preference)
- Hook structure: even more front-loaded than TikTok — first 3 seconds must "snatch" (抓人) attention; localized cultural references rewarded
- Style: trending audio / effects critical; UGC + influencer feel; Douyin algorithm differs from TikTok despite same parent company; rewards local-trend participation
- Algorithm priorities: completion + shares; local-trend audio participation
- Mandatory inject: "First 3s must 抓人 (snatch attention); trending Douyin audio (not TikTok library); CN cultural reference compatible; zh-CN simplified text."
- Hard rule: zh-CN simplified; never use TikTok trending audio directly (different sound library)

### WeChat 视频号 (Channels)

- Spec: 9:16 (1080×1920), <60s for feed
- Pacing: slower; more social-graph-driven than algorithm-driven
- Style: feels like 朋友圈 extension; less performative; relationship-led; talking-head works
- Audience signal: older CN audience (30+), professional / family context, less Gen Z
- Algorithm priorities: WeChat social graph; recommendations from contacts carry weight; 朋友点赞 signal significant
- Mandatory inject: "朋友圈 extension feel; less performative; relationship-led; older CN register; talking-head friendly."

### Bilibili

- Spec: 16:9 (1920×1080) for main video; 9:16 for 动态 (short-form)
- Length tolerance: very high — 1-30 min normal; deep-dive content rewarded
- Pacing: slow-build acceptable; subculture references rewarded
- Style: 弹幕 (danmaku) culture — design for shared real-time comment overlay; leave visual breathing room for comment stream
- Audience signal: Gen Z CN with deep niche interests (gaming, anime, tech, education, 深度测评)
- Algorithm priorities: completion + 3-link interactions (三连: 点赞投币收藏)
- Mandatory inject: "弹幕 culture compatible; visual breathing room for comment overlay; subculture reference acceptable; long-form depth."
- Hard rule: paid promotion must be disclosed via official platform tag

### XHS Video (小红书视频)

- Spec: 9:16 (1080×1920) or 3:4 for square video notes
- Length sweet-spot: <60s
- Pacing: between IG Reels (aesthetic) and TikTok (engagement) — sits in middle
- Style: authentic + aesthetic; 探店 / 测评 / 教程 / Vlog formats dominate
- Algorithm priorities: saves > research-style engagement; long captions favored over short
- Audience signal: research-driven purchase, lifestyle decision-makers
- Mandatory inject: "Authentic + aesthetic blend; 探店/测评/Vlog format; long descriptive caption; save-bait structure."

### LinkedIn Video

- Spec: 16:9 (1920×1080) preferred for feed; 1:1 (1080×1080) acceptable; 9:16 for mobile-first feeds
- Length sweet-spot: 30-90s for feed engagement; up to 10 min for thought-leadership long-form; 30-60s for native conversion ads
- Hook structure: more forgiving than TikTok — audience commits to professional content; up to 5s hook acceptable; opening with a data point or contrarian statement works
- Pacing: slower; chapter-able for longer content; B-roll + talking-head valid; professional production polish accepted (unlike TikTok where polish hurts)
- Style: B2B professional; data-forward; insight-led narrative; restrained color palette; subtitle / closed captions essential (most LinkedIn video watched with sound off in office context)
- Algorithm priorities: meaningful comments + saves + reshares (vanity metrics down-weighted); thoughtful posts surface; sales-y content de-boosted; native LinkedIn video uploads favored over YouTube cross-posts
- Audience signal: professional context, ROI-oriented, decision-makers scrolling during work hours; tolerance for longer-form content if value-dense
- Mandatory inject: "B2B professional register; sound-off subtitle design (closed captions baked in); data or insight forward; restrained palette; chapter / section structure for >60s content."
- Hard rule: never use Gen-Z meme aesthetic or casual TikTok-style hooks ("POV:" / "tell me X without telling me X") — reads as out-of-place on LinkedIn

## Output Format

Return structured prompt with:
- Platform: [name]
- Spec: [aspect ratio + max length]
- Length target: [sweet-spot duration]
- Hook architecture: [first-N-second structure]
- Pacing rules: [pattern interrupt cadence + style]
- Algorithm-optimized framing: [mandatory inject]
- Avoid list (pulled from platform section)

## Defaults

- No platform named → flag and ask user; do NOT default to TikTok or generic
- Multiple platforms named → run separate prompt pass per platform; never re-cut between platforms
- User says "video ad" with no platform → ask: TikTok / Reels / Shorts / Pre-roll? these have different architectures
- User asks platform aesthetic that contradicts reality → surface conflict and propose alternative

## Hard Limits

- Never re-cut between aspect ratios or lengths — each platform / length gets its own pass
- Never produce "generic cinematic ad" — must produce platform-native pacing
- 6s bumper / 15s skippable / 30s non-skippable are distinct architectures — never substitute one structure for another
- TikTok vs Douyin: same aspect ratio but separate audio libraries, cultural references, and algorithm; never assume cross-platform
- No TikTok watermarks when generating for IG Reels / Facebook Reels (de-boosts cross-posted content)
- Sound-on default for Reels (Meta data: 35% better engagement); design with audio in mind
- Sound-off design for LinkedIn — most office viewing is silent; closed captions baked in

## Cross-Reference Other Sub-skills

- AIGC Technical Prompt Builder: camera physics, motion strength, BGM/VO 5-element construction (model-architecture-specific INNER prompt)
- Seedance 2.0 Prompt Optimizer: Seedance 2.0 three-paragraph structure with time-slice storyboard (read it yourself when the model matches)
- This Platform Video Style sub provides the OUTER frame (length / pacing / style); the other two subs provide the INNER prompt construction