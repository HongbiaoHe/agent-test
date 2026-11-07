---
name: designer
description: Image-prompt Art Director router. Covers three task families — (1) platform-native image specs + aesthetics + algorithm priorities + audience signals across IG / XHS (小红书) / Facebook / Pinterest / LinkedIn / Twitter / Snapchat / Threads / TikTok cover / YouTube thumbnail (aspect ratios, native style, mandatory inject directives — single source of truth for platform image specs); (2) layout & aesthetic formulas orthogonal to platform — Carousel Design, Hook Visual (scroll-stop mechanics), Cheat Sheet / Save-Bait Layout, Premium Trust Visual (luxury / high-ticket / medical aesthetic), Video Cover / Thumbnail; (3) brand-asset reference lock when the user uploads product / model / palette / environment / typography / logo assets (prompt-level alternative to LoRA — @Asset N codes, hard-lock vs soft-reference, anti-drift constraints, prevents cross-subject feature bleed). SKILL.md is a router — load one or more sub-skills per task. Output is always imagePrompt + style + notes, never the image itself.
---

# Designer — Router

This file is the Designer category router. Match the user's task to the table below and load one or more sub-skills before producing the imagePrompt.

## Running in Spark desktop

These skills come from BuzzVideo's Marketing Agent and run here with Spark's own tools:

- **No plan card.** Wherever a sub-skill says "plan", "step" or "generation call", it means: show the user the finished generation prompt(s) and the key parameters (model, ratio, resolution, duration, count) in your reply, ask whether to generate, and stop. Only after the user explicitly confirms, call `generate_image` / `generate_video` / `generate_audio` — one call per step, in order. Never generate in the same turn you proposed it.
- **No locked model settings.** The model and parameters are whatever the user named in the conversation; otherwise pick a model from `list_media_models` (type image / video / audio) and recommend it with a reason. Capability facts — supported durations, ratios, resolutions, reference limits, prompt length — come from `list_media_models`; parameter values must be its exact raw values.
- **Model-specific sub-skills are not auto-loaded.** When the chosen model matches a model-specific sub-skill (e.g. Seedance 2.0 / 2.5), read that file yourself before writing the prompt.
- **References** (uploaded or previously generated images / videos / audio) are passed as `referenceVersionIds` — versionIds from tool results or the session asset list.
- **Generation is async.** The tool returns at once and the chat shows cards that update with progress; do not wait, poll or call it again.

## Sub-skill index

| File | Description (verbatim from the sub-skill's own frontmatter) |
|------|-------------------------------------------------------------|
| [platform-image-style.md](./platform-image-style.md) | Use when generating image prompts for any social media or ad platform — Instagram, Xiaohongshu (XHS / 小红书), Facebook, Pinterest, LinkedIn, Twitter/X, Snapchat, Threads, TikTok cover, or YouTube thumbnail. Returns platform-specific aspect ratio, aesthetic style, algorithm preferences, and audience signals. Single source of truth for platform image specs — never duplicate dimensions in Cross-Channel Adaptation Matrix or anywhere else. |
| [visual-concept.md](./visual-concept.md) | Use when generating an image prompt that needs a specific layout / aesthetic formula — not just a generic image. Five scenario branches in body: Carousel Design (slide-based information layout), Hook Visual (scroll-stop mechanics for paid / organic), Cheat Sheet / Save-Bait Layout (information-dense infographic), Premium Trust Visual (luxury / high-ticket aesthetic), Video Cover / Thumbnail (cover-frame formula). Combine with Platform Image Style (provides platform-specific specs + aesthetic) for full image prompt. |
| [brand-reference-asset-inject.md](./brand-reference-asset-inject.md) | Use when the user has uploaded brand assets (color palette, product image, model/face reference, packaging shot, typography sample, environment reference) and we are generating an image prompt that must lock those assets exactly. Injects explicit asset references into the prompt to prevent attribute drift, feature bleed across subjects, and palette substitution. This is the prompt-level alternative to LoRA training — no model fine-tuning required. |

## Loading rules

- **Multiple sub-skills may be loaded together.** Typical combos:
  - Single-platform, single image → `platform-image-style` only.
  - Carousel / hook visual / cheat sheet / cover → `platform-image-style` + `visual-concept`.
  - User uploaded product / model / palette / logo → stack `brand-reference-asset-inject` on top of either combo above.
- **Read sub-skill files in full** — call `read_file(path)` with no `limit` / `offset`. Pagination is forbidden on skill files.
- Never specify image model / aspect ratio / resolution in the prompt — those come from upstream `modelConfig`. Sub-skills enforce this.
