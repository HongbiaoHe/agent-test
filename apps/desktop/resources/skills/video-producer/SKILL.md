---
name: video-producer
description: Use for ANY video / 视频 task — generating, writing, or optimizing an AIGC video prompt. Triggers on video, 视频, 视频脚本, video prompt, AIGC video, 生成视频, 优化视频, t2v, i2v, Seedance, Veo, TikTok, Reels, Shorts, 抖音, 视频号, B站, 小红书, hook, CTA. Router — loads `video-script-framework` first, then platform + model sub-skills.
---

# video-producer — Router

Router for any video-prompt task. Read `video-script-framework.md` first, then load the sub-skill(s) the task needs.

## Running in Spark desktop

These skills come from BuzzVideo's Marketing Agent and run here with Spark's own tools:

- **No plan card.** Wherever a sub-skill says "plan", "step" or "generation call", it means: show the user the finished generation prompt(s) and the key parameters (model, ratio, resolution, duration, count) in your reply, ask whether to generate, and stop. Only after the user explicitly confirms, call `generate_image` / `generate_video` / `generate_audio` — one call per step, in order. Never generate in the same turn you proposed it.
- **No locked model settings.** The model and parameters are whatever the user named in the conversation; otherwise pick a model from `list_media_models` (type image / video / audio) and recommend it with a reason. Capability facts — supported durations, ratios, resolutions, reference limits, prompt length — come from `list_media_models`; parameter values must be its exact raw values.
- **Model-specific sub-skills are not auto-loaded.** When the chosen model matches a model-specific sub-skill (e.g. Seedance 2.0 / 2.5), read that file yourself before writing the prompt.
- **References** (uploaded or previously generated images / videos / audio) are passed as `referenceVersionIds` — versionIds from tool results or the session asset list.
- **Generation is async.** The tool returns at once and the chat shows cards that update with progress; do not wait, poll or call it again.

## Sub-skill index

| File | When to load | Model-matched load |
|------|--------------|----------------------|
| [video-script-framework.md](./video-script-framework.md) | **Always.** First read on every video task — script-blueprint quality gate. | **Forced first read** |
| [platform-video-style.md](./platform-video-style.md) | Whenever any platform is mentioned (TikTok / Reels / Shorts / 抖音 / 视频号 / B站 / 小红书 / LinkedIn / etc.) — OUTER frame: length, pacing, hook, aesthetic, algorithm. | — |
| [aigc-technical-prompt-builder.md](./aigc-technical-prompt-builder.md) | When model is Seedance 1.5 Pro / Veo 3.1 / Veo 3.1 Fast — INNER prompt: token order, camera physics, motion, audio. | — |
| [seedance-2_0-prompt-optimizer.md](./seedance-2_0-prompt-optimizer.md) | When model is Seedance **2.0** (and only 2.0) — INNER prompt: 3-paragraph grammar, @Image/@Video refs, single-camera-per-slice. | **Forced** when model ∈ {seedance 2.0, seedance2.0, sd2, sd 2.0, 即梦 2.0} |
| [seedance-2_5-prompt-optimizer.md](./seedance-2_5-prompt-optimizer.md) | When model is Seedance **2.5** (and only 2.5) — INNER prompt: story contract, material mapping / `@Image N` roles, stage-based long-video structure (up to 30s), editing / keyframe / extension templates. | **Forced** when model ∈ {seedance 2.5, seedance2.5, sd2.5, sd 2.5, 即梦 2.5} |
| [seedance-2_5-advanced-modes.md](./seedance-2_5-advanced-modes.md) | Seedance 2.5 **only**, and only for non-plain-generation modes — video / audio editing, video extension, keyframe anchors, storyboard grids, blockout re-render. | — |

## Loading rules

- **`video-script-framework` is mandatory first read.** No exceptions for model / platform / duration. If it returns `DEFECT REPORT`, surface defects and STOP — do not proceed until the script is fixed.
- **Standard combos** (always preceded by `video-script-framework`):
  - Seedance 1.5 Pro / Veo 3.1 / Veo Fast → `+ platform-video-style + aigc-technical-prompt-builder`
  - Seedance 2.0 → `+ platform-video-style + seedance-2_0-prompt-optimizer` (read it yourself when the model matches)
  - Seedance 2.5 → `+ platform-video-style + seedance-2_5-prompt-optimizer` (read it yourself when the model matches)
    — add `+ seedance-2_5-advanced-modes` ONLY when the task edits or extends an existing video (a source video in `referenceVersionIds` (a video versionId)) or needs first/last-frame, storyboard-grid or blockout control.
- **One model optimizer per task — 2.0 and 2.5 are mutually exclusive.** Match the chosen model's version EXACTLY: `seedance-2_0-prompt-optimizer` is for 2.0 only, `seedance-2_5-prompt-optimizer` is for 2.5 only. "Seedance 2" as a bare prefix is NOT a match for 2.5 — read the full version from the chosen model's name in `list_media_models`. Never read both files in one task, never fall back from one to the other, and never blend their prompt grammars: they define different prompt structures, different reference syntaxes, and different duration ceilings (2.0 up to 15s, 2.5 up to 30s — verify via `list_media_models` (type=video) for the chosen model). If the locked video model is neither 2.0 nor 2.5, use `aigc-technical-prompt-builder` and read neither.
- **Read sub-skill files in full** — no `limit` / `offset`. Pagination forbidden. Read only the files the task actually needs: `seedance-2_5-advanced-modes` is for editing / extension / keyframe / storyboard / blockout tasks only, and a plain text-to-video or image-to-video task must NOT load it.
- Translate the script faithfully (scenes, timestamps, spoken lines, captions, SFX, transitions). Never reinterpret narrative.
- Never specify aspect ratio / resolution / duration **inside the prompt text** — they go into the `generate_video` call's `params` (raw values from `list_media_models`). The user-chosen duration still drives the SCRIPT's total length and the step's `duration` field (see `video-script-framework` §2) — it is never to be ignored or replaced with a remembered cap.
- **Single-step default**: One video task that fits the model's single-generation `duration` limit → ONE `generate_video` call. The script's blocks / time-slices / storyboard cells are the INTERNAL paragraph layout of a single prompt — never one-step-per-block. Multi-step video plans are allowed ONLY for: total runtime exceeding the model's largest supported `duration` (read from `list_media_models` (type=video) for the chosen model — e.g. 15s for Seedance 2.0, 30s for Seedance 2.5), multiple distinct platforms, or creatively independent videos. See `video-script-framework` Hard Limits for the full rule.
