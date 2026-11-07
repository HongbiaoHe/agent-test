---
name: aigc-technical-prompt-builder
description: Use when the video model is NEITHER Seedance 2.0 NOR Seedance 2.5 — i.e. Seedance 1.5 Pro, Veo 3.1, or Veo 3.1 Fast. Those two have their own optimizers (`seedance-2_0-prompt-optimizer` / `seedance-2_5-prompt-optimizer`); do not use this file for them. Builds the INNER prompt: token order, camera physics, motion strength, BGM/VO audio. Triggers on model names: seedance 1.5, sd1.5, veo 3, veo 3.1, veo fast, veo3.
---


# AIGC Technical Prompt Builder

Translates creative briefs into technical AIGC prompt packages. Covers model-specific prompt architecture (Seedance 1.5 Pro vs Veo 3.1 vs Veo 3.1 Fast), camera physics library, motion strength descriptors, and full BGM/VO parameter construction with all 5 required elements each.

## When to Use

Fire after the scene-by-scene script is locked AND the user has named one of:
- seedance 1.5 / seedance 1.5 pro
- veo 3.1 / veo
- veo 3.1 fast / veo fast

If the model is seedance 2.0, route to the Seedance 2.0 Prompt Optimizer skill instead (read that file yourself).

## Apply

### 1. Model-Specific Prompt Architecture

SEEDANCE 1.5 PRO — physics and human realism:
- Lead with: subject → physical interaction → material physics
- Key tokens: photorealistic skin texture, visible pores, subsurface scattering, natural micro-expressions, realistic hair physics, accurate light refraction, naturalistic body movement
- Avoid: abstract aesthetics, pure environment shots

VEO 3.1 — cinematic art direction:
- Lead with: lighting setup → environment → subject → mood
- Key tokens: cinematic color grading, volumetric lighting, anamorphic lens flare, shallow depth of field, architectural precision, high aesthetic consistency, film grain at 5%, neutral density filter
- Avoid: high human realism close-ups

VEO 3.1 FAST — speed and simplicity:
- Lead with: action → subject → environment → energy
- Key tokens: bold colors, high contrast, clean composition, dynamic motion, graphic energy, social-native aesthetic
- Best for: abstract visuals, product shots, motion graphics, quick iterations

### 2. Camera Physics Library

| Move | Prompt |
|------|--------|
| Dolly zoom | "slow dolly-in with simultaneous zoom-out, subject stays same size while background compresses" |
| Orbital tracking | "360-degree orbital camera path around subject at constant radius, smooth mechanical motion" |
| Crane shot | "vertical camera rise from low angle to elevated POV, revealing the environment progressively" |
| Handheld jitter | "slight handheld camera shake, organic movement, documentary feel" — Traffic Engine only |
| Static locked | "completely static camera, tripod-mounted, zero movement" — for data reveals |

### 3. Motion Strength Descriptors

- Aggressive Fast-Cut: "rapid cut sequence, 2-3 second intervals, kinetic energy, jump cuts permitted"
- Cinematic Flow: "slow deliberate movement, 5-7 second intervals, smooth dolly or crane, no jump cuts"
- Rhythmic Pulse: "medium pace, 3-5 second intervals, rhythm-matched to BGM beat, purposeful transitions"

### 4. Audio Prompt Construction (5 elements each — mandatory)

BGM for Suno/Udio — Style + Genre + BPM + Mood + Key Instruments:
- Traffic Engine: Electronic trap, 128 BPM, high energy urgency, 808 bass, hi-hat rolls, synth stabs, no melody
- Premium Trust: Minimal orchestral, 65 BPM, calm authority, solo cello, sparse piano, no percussion, no drop
- DR/Conversion: Cinematic pop, 95 BPM, confident resolution, warm piano lead, light strings, subtle percussion

VO Profile — Gender + Age range + Tone + Intensity + Prosody:
- Traffic Engine: Female, 28-35, direct and energetic, medium-high intensity, punchy delivery with short pauses
- Premium Trust: Female, 35-45, warm clinical authority, low intensity, measured pace ≤140 WPM, deliberate emphasis on data points
- DR/Testimonial: Peer-to-peer, same demographic as audience, conversational, natural delivery, not rehearsed-sounding

### 5. Reference Image Animation

If reference image URLs are provided:

> "Starting from the provided reference image, animate with [specific camera move] + [subject motion] + [environmental change]. Maintain visual continuity with the reference frame throughout."

## Output Format

Return structured payload:
- Model selection + rationale
- videoPrompt (English, model-specific token order)
- motionDescription (camera physics + motion strength)
- BGM Prompt (5 elements)
- VO Profile (5 elements)

## Defaults

- Model not specified → surface to user before generating; do not guess
- BGM mood not specified → derive from funnel stage (Traffic Engine / Premium Trust / DR-Conversion)
- VO profile not specified → default to audience demographic; surface assumption

## Hard Limits

- All videoPrompt content: English only (downstream model requirement)
- Do NOT specify aspect ratio, resolution, or duration in the prompt — handled by system settings
- One camera movement per shot — simultaneous pan + tilt + dolly + zoom forbidden (per-model constraint)
- Token order matters per model — follow the architecture in §1; mis-ordered tokens degrade output quality
- **Text Overlay carry-over (incl. position):** Every `Text Overlay` line from the locked script MUST appear in the videoPrompt as on-screen text — verbatim wording, timing, AND the script's `Text Overlay Position` (default `bottom safe area, clear of the subject's face`). NEVER silently center an overlay — centered text covers the subject's face.

## Cross-Reference

- Platform Video Style: OUTER frame (length, platform pacing, hook structure) — read this BEFORE building the INNER prompt here
- Seedance 2.0 Prompt Optimizer: when model is Seedance 2.0, that skill takes over (read it yourself when the model matches); this skill is for Seedance 1.5 Pro / Veo 3.1 / Veo Fast only