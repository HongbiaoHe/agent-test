---
name: copywriter
description: Marketing-copy router. Covers three task families — (1) paid ad copy + landing page conversion (dark post / sponsored / Meta / TikTok / LinkedIn ads, sales / product pages, Problem-Agitate-Solution-CTA, 4U headline test Urgent / Unique / Ultra-Specific / Useful); (2) email marketing (subject line ≤50 chars / preview text / hero / body / single primary CTA, covering promo / newsletter / abandoned-cart / welcome / re-engagement / sales sequence / event invite); (3) KOL / KOC / influencer briefs to creators (deliverables, hashtags, avoid list, FTC #ad + AI-tool disclosure, usage rights). Short-video scripts and on-screen text are owned by `video-producer` — do NOT route them here. SKILL.md is a router — load one or more sub-skills per task.
---

# Copywriter — Router

This file is the Copywriter category router. Match the user's task to the table below and load one or more sub-skills before producing any output.

## Sub-skill index

| File | Description (verbatim from the sub-skill's own frontmatter) |
|------|-------------------------------------------------------------|
| [ad-copywriting.md](./ad-copywriting.md) | Use when writing paid ad copy or landing page conversion copy. Two scenario branches: Dark Post Ad Copy (Problem-Agitate-Solution-CTA for IG / FB / TikTok / LinkedIn paid ads with platform-specific character limits and audience temperature) and Landing Page Conversion (hero header, feature-benefit translation, trust signal hierarchy, high-converting CTA). All hooks / headlines / CTAs pass the 4U quality test (Urgent / Unique / Ultra-Specific / Useful) before output. |
| [Email-CRM-copy.md](./Email-CRM-copy.md) | Use when writing email marketing copy — promotional / newsletter / abandoned-cart / welcome / re-engagement / sales sequence / event invite. Produces subject line (≤50 chars, mobile-optimized), preview text (complementary to subject), hero header, body copy, single primary CTA (single-CTA emails generate 371% more clicks than multi-CTA). All output mobile-first — 70%+ of emails are read on phone. |
| [KOL-brief.md](./KOL-brief.md) | Use when producing an influencer / KOL communication brief — the document sent to creators (not the audience). Outputs structured brief per KOL including campaign overview, deliverables (platform / format / specs), must-mention hashtags + handles, avoid list, do's and don'ts, content direction suggestions, timeline, compliance disclosures (FTC #ad / AI-tool disclosure), and usage rights. Adapts per KOL's personal brand to preserve creator authenticity. |

## Loading rules

- **Multiple sub-skills may be loaded together.** Typical combos: paid LP + email sequence = `ad-copywriting` + `Email-CRM-copy`.
- **Read sub-skill files in full** — call `read_file(path)` with no `limit` / `offset`. Pagination is forbidden on skill files.
- A KOL brief is for the creator, not the audience. Audience-facing paid copy still routes through `ad-copywriting`.
- Short-video scripts (Reels / TikTok / Shorts / 抖音) and on-screen text overlays are NOT in this router — they live under `video-producer/video-script-framework`.
