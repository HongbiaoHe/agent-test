---
name: brand-reference-asset-inject
description: Use when the user has uploaded brand assets (color palette, product image, model/face reference, packaging shot, typography sample, environment reference) and we are generating an image prompt that must lock those assets exactly. Injects explicit asset references into the prompt to prevent attribute drift, feature bleed across subjects, and palette substitution. This is the prompt-level alternative to LoRA training — no model fine-tuning required.
---


# Brand Reference Asset Inject

When the user uploads brand assets, generic image-gen prompts will drift: the product turns into "a similar product," the brand color becomes "close to that color," the model's face becomes "someone of that age." This skill locks each uploaded asset to an explicit reference and injects anti-drift constraints into the prompt.

This is the prompt-level alternative to LoRA fine-tuning — cheaper, faster, no training pipeline required. For sustained multi-campaign brand DNA, consider LoRA later; for single-campaign brand lock, this skill is sufficient.

## When to Use

Fire when the brief includes ANY of:
- Uploaded product image / packaging shot ("keep this exact bottle")
- Uploaded model / face reference ("same model across all images")
- Declared brand color palette (hex codes or named brand colors)
- Uploaded environment / setting reference ("this exact storefront")
- Uploaded typography sample (custom brand typeface)
- Phrases: keep the product, same model, our brand colors, match the reference, 保留产品, 上传了 logo, 品牌色卡

## Decision Logic

1. Inventory uploaded assets in order of appearance; map to stable codes @Asset 1, @Asset 2, etc.
2. Classify each asset (product / model / palette / environment / typography / logo)
3. Determine reference weight — hard lock (exact reproduction required) vs soft reference (style/feature only)
4. Inject explicit constraints into the prompt per asset type (see Apply section below)
5. Prevent cross-subject feature bleed when multiple subject assets are present (per 2026 Midjourney guidance: word like "glasses" can accidentally bleed across characters)
6. Surface conflicts when user request contradicts uploaded asset (e.g., "luxury" aesthetic requested but product image is mass-market)

## Apply

### 1. Asset Inventory & Mapping

Scan all uploaded assets in order of appearance. Assign each a stable code:
- First uploaded image = @Asset 1
- Second = @Asset 2
- And so on

In the final prompt, always reference assets via these codes, never by raw filename or asset-xxx ID. This matches the syntax used by Seedance 2.0 and Veo for downstream compatibility.

### 2. Asset Classification

For each @Asset N, classify into one of:

| Class | Examples | Lock strength |
|---|---|---|
| Product | Bottle, packaging, garment, device | Hard lock (exact reproduction) |
| Model | Face photo, body shot, hand close-up | Hard lock for face/identity; soft for clothing |
| Palette | Hex codes, brand color swatches | Hard lock |
| Environment | Storefront, factory, lifestyle scene | Soft reference (style/mood) |
| Typography | Brand typeface sample | Hard lock for rendered text |
| Logo | Brand logo SVG/PNG | Hard lock (exact reproduction) |

### 3. Per-Class Injection Templates

Product (Hard Lock):
> "The product is @Asset N (the [product description]). Reproduce the product exactly as shown in @Asset N — same shape, same packaging, same label, same proportions. Do not redesign, do not simplify, do not 'inspire by'. Place the product into the new scene without modifying its appearance."

Model / Face (Hard Lock):
> "The subject is @Asset N (the person shown). Match @Asset N's facial features exactly — same face structure, same eye shape, same nose, same skin tone. Outfit and pose may change per scene; face must remain identical across all generated frames."
>
> Reference weight guidance (where supported by model):
> - Midjourney: --cref [@Asset N URL] --cw 100 for full face + hair + outfit lock; --cw 0-30 for face only
> - Seedance 2.0: declare @Image N is [Subject Name] (asset ID: [...]) in Paragraph 1

Palette (Hard Lock):
> "Brand palette (use only these colors): [hex codes]. Accent color reserved for CTA / data highlights only. No substitutions — do not shift hue, do not pastel-ize, do not desaturate. Background and surface colors must come from this palette."

Environment (Soft Reference):
> "Inspired by the style and mood of @Asset N (the [environment description]). Match the lighting tone, material palette, and overall atmosphere. The specific spatial layout may differ."

Typography (Hard Lock):
> "All rendered text uses the typeface shown in @Asset N. Display weight ≥600, body weight ≤400. No substitutions for 'this one asset'. If the typeface cannot be reproduced in generation, render text in a sans-serif of similar weight and flag."

Logo (Hard Lock):
> "The brand logo is @Asset N. Render the logo exactly — same proportions, same colors, same spacing. Place in safe zone (top-right or bottom-right, 5-10% of canvas). Do not modify, recolor, or 'simplify' the logo."

### 4. Multi-Subject Anti-Bleed Protocol

When 2+ subject assets are uploaded (e.g., two different models in one frame):

- Assign explicit per-subject descriptors that don't overlap: "the woman on the left in @Asset 1 (wearing the gray-blue jacket)" vs "the man on the right in @Asset 2 (wearing the black shirt)"
- Avoid prompt words that could apply to both — e.g., if @Asset 1 wears glasses and @Asset 2 does not, do NOT use the word "glasses" anywhere in the shared prompt; use "the person in @Asset 1's eyewear" instead
- Add fixed/locked camera + explicit positioning to reduce attribute drift
- For video: prefer per-shot prompts with single subject per shot rather than crowded multi-subject frames

### 5. Conflict Detection

Surface conflicts to user (do NOT silently override):

- Aesthetic vs asset mismatch: "You uploaded a mass-market product photo but asked for luxury aesthetic. Options: (a) keep product, soften premium framing; (b) replace product image with premium re-shoot reference; (c) proceed with conflict."
- Palette vs platform: "Your declared palette includes #FF0000 but you asked for Xiaohongshu 高级感 aesthetic, which requires desaturated cool tones. Reconcile?"
- Model age vs target audience: "@Asset 1 shows a 50+ model, but target is 18-25. Proceed or replace?"
- Logo placement conflict: "Brand guidelines specify bottom-right logo, but platform composition needs bottom-right for CTA. Move logo to top-right?"

## Output Format

Return enriched prompt with explicit asset references injected:

- Asset map: list of @Asset N → [class] → [lock strength]
- Enriched prompt: the original prompt with per-class injections inserted at appropriate positions
- Conflicts surfaced (if any): listed for user resolution before generation
- Notes: any silent defaults applied (e.g., "Logo placement defaulted to top-right due to no user spec")

## Defaults

- No assets uploaded → skill does not fire; downstream prompt proceeds without injection
- Asset uploaded but classification ambiguous → ask user to confirm class
- Palette declared but no hex codes → attempt to extract hex from uploaded brand image; surface for confirmation
- Logo uploaded but no placement preference → default to top-right (5-10% of canvas)
- Reference weight not specified → default to hard lock for product/model/palette/logo; soft for environment

## Hard Limits

- Never simplify uploaded product/logo — if generation model cannot reproduce exactly, flag and surface to user; do not silently approximate
- Never substitute palette colors — hex codes are exact; no "close enough"
- Never apply one asset's features to a different subject in multi-subject prompts — use explicit per-subject descriptors
- Never modify the logo (recolor, simplify, re-proportion) — brand consistency requires exact reproduction
- Reference weight: default to hard lock for any commercial brand asset; soft reference only for environment/mood

## Cross-Reference

- Platform Image Style: provides the OUTER platform-specific aesthetic and spec; this skill provides the brand asset lock that operates ON TOP of platform style
- Brand Soul Enforcer (Marketing layer): provides the verbal + visual brand rules; this skill is the asset-level execution of those rules
- Marketing → Brand Positioning: if the brand is still being positioned (0→1 stage), this skill is premature; assets need to exist first