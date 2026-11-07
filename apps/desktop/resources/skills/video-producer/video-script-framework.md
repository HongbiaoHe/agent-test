---
name: video-script-framework
description: ALWAYS load first on EVERY video task — no exceptions. Script-blueprint quality gate: validates 0-3s hook, a body paced to the target duration (the user-chosen length) (tiers — short ≤5s / mid 6-10s / long 11-15s / extended 16s+), 50%-mark open loop, last-beat single-CTA, text-overlay cues. Returns PASS / DEFECT / AUTO-FILL. Triggers on: video, 视频, 视频脚本, video script, hook, CTA, 完播率, retention.
---

# Video Script Framework

This sub-skill is the SCRIPT-LAYER contract for video-producer. It runs BEFORE every other sub-skill on every invocation. The video-producer's prompt-build only succeeds when the upstream script obeys the framework below — otherwise the AIGC output inherits a structurally weak script and burns generation cost. Treat this file as the quality gate executed prior to `platform-video-style`, `aigc-technical-prompt-builder`, and `seedance-2_0-prompt-optimizer`.

## When to Use

Always. Mandatory first load on every video-producer task. No exceptions for model, platform, or duration.

## Apply

### 1. 0-3s Pattern Interrupt (mandatory)

The opening 0-3s VO line MUST match ONE of:
- Contrarian: "Everything you know about [X] is wrong."
- Shocking stat: "[X]% of [audience] don't know this."
- Extreme pain: "If you're still doing [X], stop right now."
- Direct address: "This is for anyone who [situation]."

**BAN** (in opening): "Hi guys," / "Welcome back," / "Today I'm going to," / "So basically" / brand logo reveal / pleasantry / slogan.

If the upstream script opens with any banned form, mark as DEFECT and surface to user before building any AIGC prompt.

### 2. Body Pacing by Duration (target duration comes from upstream)

**This file does NOT own a duration number.** The script's total duration is the TARGET resolved from upstream, in this exact order:

1. **the duration the user chose for this video** (a length the user explicitly picked for this video in the conversation, or agreed to when you recommended the model). When present, this IS the target: the timeline MUST total **exactly** that many seconds. Never shorten, extend, or round it because of any rule in this file, in `platform-video-style`, or in a strategist phase plan.
2. No lock, but the user stated a length in the brief ("a 20s ad") → that value, if the video model supports it. Model duration limits live in DB — read them from `list_media_models` (type=video) for the chosen model. **Never hard-code a seconds cap in this file's reasoning** (Seedance 2.0 tops out at 15s, Seedance 2.5 at 30s, Veo 3.1 at 8s — illustrative only; the capabilities line is the truth and new models change it).
3. Neither → see "Defaults" below.

Four pacing tiers cover the supported range. Pick the tier the TARGET falls into:

- **Short (≤5s)** — bumper / pre-roll style:
  - ONE beat only. Collapse PATTERN_INTERRUPT + CTA into the same time-slice.
  - Usually a single VO line that doubles as hook and call-to-action.
  - No separate MECHANISM block. No OPEN_LOOP.
- **Mid (6-10s)** — single-message ad:
  - PATTERN_INTERRUPT (0-3s) + MECHANISM (3s → last-3s) + CTA (last 3s).
  - OPEN_LOOP optional. If included, fold it into the closing sentence of the mechanism rather than a separate block.
- **Long (11-15s)** — full short-form architecture:
  - PATTERN_INTERRUPT (0-3s) + MECHANISM (3s → 50% mark) + OPEN_LOOP (~50% mark) + CTA (last 3s).
  - OPEN_LOOP mandatory — single biggest completion-rate lever in this tier.
  - New information unit every **2-3 seconds max**; each beat must land fast.
- **Extended (16s and above — whatever the model supports)** — multi-beat short-form. A longer runtime is NOT a licence to stretch the 11-15s architecture; it needs its own retention scaffolding:
  - PATTERN_INTERRUPT (0-3s) + MECHANISM/PROOF beats + **mid-roll RE-HOOK** (a second `PATTERN_INTERRUPT` block at ~1/3 of the runtime, where drop-off concentrates — new visual register + a fresh §1 pattern line, never a restatement of the opener) + OPEN_LOOP (~50% mark, mandatory) + MECHANISM/PROOF payoff + CTA (last 3s).
  - New information unit every **3-4 seconds** — slightly looser than the long tier so each beat can breathe, but never a beat longer than 5s.
  - Block count ≈ `round(target / 4)`, minimum 5 blocks for any 16s+ target. A 25s script with 4 blocks is under-paced → DEFECT.
  - Every beat after the RE-HOOK must add NEW information (new feature, new proof, new consequence). Re-showing the same product shot with different wording is filler → DEFECT.

If the script's timeline blocks contradict the pacing tier above, surface as DEFECT. If the script's total duration differs from the §2 target — **including a script that is SHORTER than the target** (the unplanned tail is footage the user still pays for) — surface as DEFECT. See Hard Limits.

### 3. Open Loop at 50% Mark

- **Extended tier (16s+)**: MANDATORY, plus the mid-roll RE-HOOK at ~1/3 (§2). Plant a question at the ~50% mark answered ONLY in the final 3s. Missing OPEN_LOOP or missing RE-HOOK → DEFECT.
- **Long tier (11-15s)**: MANDATORY. Plant a question answered ONLY in the final 3s. Example: "But here's what nobody tells you..." If the 50%-mark block lacks an open-loop, surface as DEFECT.
- **Mid tier (6-10s)**: OPTIONAL. If used, fold the question into the closing sentence of MECHANISM — do NOT add a separate OPEN_LOOP block.
- **Short tier (≤5s)**: SKIP — total runtime is too short for setup-and-payoff. Missing open-loop on ≤5s does NOT trigger DEFECT.

### 4. Final CTA (last beat)

- **Extended tier (16s+)**: dedicated CTA block covering the final 3s.
- **Long tier (11-15s)**: dedicated CTA block covering the final 3s.
- **Mid tier (6-10s)**: dedicated CTA block covering the final 3s.
- **Short tier (≤5s)**: CTA shares its time-slice with PATTERN_INTERRUPT — fuse into a single imperative phrase ≤6 words (e.g. "Stop scrolling — save this.").
- Single CTA only in all tiers: `Comment [KEYWORD]` / `Save this` / `Follow for part 2`.
- Never: multi-option CTAs / "Like, comment, and subscribe".

### 5. Verbatim Carry-Over Tracks (mandatory in every downstream AIGC prompt)

Two tracks from the script MUST be carried verbatim into the final AIGC prompt — never rephrased, translated, paraphrased, summarized, or dropped by any downstream sub-skill (`platform-video-style`, `aigc-technical-prompt-builder`, `seedance-2_0-prompt-optimizer`, `seedance-2_5-prompt-optimizer`). The same applies to the block time-slices themselves: a confirmed script's blocks must reach the §2 target duration in the prompt the downstream optimizer emits — no dropped trailing block, no shortened timeline.

**5a. Narration / VO (spoken track)**

- Every `Narration / VO` line of every block must appear in the AIGC prompt, scoped to its exact `mm:ss-mm:ss` time-slice.
- Keep the original quotation marks and the **original language** of the script — do not translate VO into English (or any other language) even when the rest of the prompt is English. AIGC video models (Seedance 2.0 / Veo 3.x) generate lip-synced audio from the literal VO string.
- Sentence shape: `<time-slice>: ... Narration / VO (<lang>): "<line>".` The label `Narration / VO` is mandatory — `Voice-over:`, `VO:`, `Audio:` are NOT substitutes.
- If a block has no VO, omit the field entirely. Do not invent VO. Do not collapse two blocks' VO into one line.

**5b. Text Overlay (on-screen text track)**

- Opening (0-1s): hook condensed to ≤6 words.
- Mid (optional): key data point.
- CTA: exact wording, last 3s for mid / long tier; for short tier (≤5s) the CTA overlay shares the opening time-slice with the hook (fused per §4).
- **Position (mandatory pairing).** Every `Text Overlay` line MUST be paired with a `Text Overlay Position`. **Default = bottom safe area, explicitly clear of the subject's face** (written in the reply language). The user may change it to `center` / `top` / or a custom spot (e.g. `bottom-left`). **NEVER default to center** — a centered overlay covers the subject's face and is the #1 user complaint. If the user did not specify a position, AUTO-FILL the default and log it.
- Every `Text Overlay` line must appear in the AIGC prompt as on-screen text with its exact wording, timing (start–end seconds), and its `Text Overlay Position` carried **verbatim** from the script — never silently re-centered.

**Defect surface:** If a downstream prompt drops a VO line, paraphrases a Text Overlay, or merges/splits time-slices, the script-framework gate must FAIL the build and surface the missing line(s) — even if the rest of the prompt is otherwise valid.

## Block Blueprint (schema validation)

If the script (whether drafted by this sub-skill or supplied upstream) is in block format, expect this exact structure per segment:

```
[mm:ss-mm:ss] BLOCK_NAME (function tag)
- Visual: <shot / scene / action — one sentence>
- Narration / VO: "<the exact VO line, in quotes>"
- Text Overlay: <the exact on-screen text as it will appear; write none if there is none>
- Text Overlay Position: <where the text sits — default: bottom safe area, clear of the subject's face; may be center / top / custom such as bottom-left. Write none when Text Overlay is none>
- SFX (optional): <sound effect — omit this line if none>
```

The labels above are a schema, not a language choice: write every value in the reply language (see the system prompt's LANGUAGE rule).

Schema rules to validate:
- `BLOCK_NAME` ∈ {`PATTERN_INTERRUPT`, `PROBLEM`, `MECHANISM`, `OPEN_LOOP`, `PROOF`, `CTA`}. `PATTERN_INTERRUPT` may appear twice in the **extended tier** only (opener + mid-roll re-hook).
- Time ranges contiguous, cover full duration, never overlap.
- **The last block's end time MUST equal the §2 target duration exactly** — no truncation, no overshoot. A 25s target whose timeline stops at 00:15 is a DEFECT (the user pays for 25s of footage; the last 10s would be unplanned).
- Block count matches §2 pacing tier (one info unit per 2-3s for ≤15s, per 3-4s for 16s+).
- The opening block MUST be `PATTERN_INTERRUPT`; its VO MUST match one of the §1 patterns. For **extended / long / mid tier** it spans 0-3s; for **short tier (≤5s)** it may extend to the entire / leading portion of the timeline.
- For **long (11-15s) and extended (16s+) tiers**, an `OPEN_LOOP` block MUST appear at the ~50% mark with the question in the VO field. Extended tier additionally needs the mid-roll `PATTERN_INTERRUPT` re-hook at ~1/3 (§2). Mid / short tiers do NOT require a separate `OPEN_LOOP` block (see §3).
- The final block MUST be `CTA` — covering the last 3s for **mid / long / extended tier**, or fused into `PATTERN_INTERRUPT` for **short tier (≤5s)**. The CTA line lives in BOTH `Text Overlay` AND `Narration / VO`.
- Whenever a block's `Text Overlay` ≠ `none`, it MUST carry a `Text Overlay Position`. If missing, AUTO-FILL to `bottom safe area, clear of the subject's face` and log it. NEVER auto-fill or render `center` — a centered overlay covers the subject's face.
- One track = one bullet. NEVER collapse to prose.

## Defaults (only if user did not specify)

- Duration → resolve per §2 (user-chosen duration first, then a length stated in the brief). **A locked value is a user-stated value — never treat it as "no duration" and never default over it.** Only when BOTH are absent: default to **15s** (long tier) — or the model's largest `duration` option if that is smaller (e.g. 8s on Veo 3.1). That 15s is a no-information fallback, NOT a model cap.
- No funnel stage → default to TOF.
- No CTA → default to "Follow for part 2".
- No text-overlay position → default to **bottom safe area, clear of the subject's face** (never center).

Never override a user-stated value. Log every default applied in AUTO-FILL output.

## Hard Limits

- **One video task within the model's single-generation limit = ONE downstream `generate_video` call.** The block / time-slice / storyboard structure defined above is the INTERNAL paragraph layout of a SINGLE prompt — it controls how the model paces scene changes WITHIN one generation. NEVER translate the script's blocks (PATTERN_INTERRUPT / MECHANISM / OPEN_LOOP / CTA) or time-slices (0-3s / 3-7s / …) into multiple generation calls. Cross-slice camera cuts, scene changes, and multi-shot pacing are all expressed inside ONE prompt — the AIGC model (Seedance 2.5 / Seedance 2.0 / Veo 3.x / Seedance 1.5 Pro) handles them natively.
- Multi-step video plans are allowed ONLY when ONE of these is true:
  - (a) total runtime exceeds the model's largest supported `duration` (from `list_media_models` (type=video) for the chosen model) and must be split into segments that each fit;
  - (b) multiple distinct platforms requested (TikTok + Reels + Douyin → one step per platform pass);
  - (c) creatively independent videos (different hooks, products, or campaigns — not different scenes of the same story).
  If none of (a)/(b)/(c) holds, emit exactly ONE video step regardless of how many blocks the script contains.
- **The script's total duration MUST equal the §2 target — never silently truncate and never silently expand.** A user-chosen duration of 25s means a 25s timeline, not a 15s one. If the target cannot be met (e.g. the user asks for 60s and the chosen model's largest `duration` option is 30s), surface as DEFECT in the framework report and propose: (a) compress to a supported duration, OR (b) split into multiple clips that each fit the model's limit, generated independently (this is the ONLY split that maps to multiple steps). Say it in the user's language — never resolve the conflict silently.
- **Duration limits are DB facts, not framework constants.** Read the chosen model's supported `duration` values from `list_media_models` (type=video) for the chosen model (Seedance 2.0: up to 15s · Seedance 2.5: up to 30s — illustrative, verify per model). Never assert a seconds cap from memory, and never let a remembered cap override a locked value.
- **Length beyond the chosen model's cap → the user picks the model.** If the brief asks for more than the chosen model's largest `duration` option, do not silently plan the cap: tell the user, then offer (a) splitting into clips that each fit, or (b) switching to a model whose `duration` options cover the length (call `list_media_models` to name such a model). When the user has not chosen a model, choose the video model BY the requested length — a model whose `duration` options include it.
- **Carry the target duration into the plan.** When the script is confirmed and `generate_video` is called, its `params.duration` MUST be the §2 target (equal to the user-chosen duration when present) — the step field takes precedence over the locked config downstream, so writing a smaller value there silently downgrades the user's choice.
- Never open the video with brand name, logo reveal, or pleasantry — kills completion rate.
- zh-HK script: Traditional Chinese only in VO and overlay text.
- zh-CN script: Simplified Chinese only.
- Never rewrite narrative — script is the blueprint. This sub-skill validates STRUCTURE, not CONTENT.

## Output (what this sub-skill returns to you (the main agent))

This sub-skill does NOT produce the final AIGC prompt. Its output is exactly ONE of:

1. **PASS** — script obeys §1-§5. Downstream sub-skills proceed. Log: `script-framework: PASS`.

2. **DEFECT REPORT** — itemized list of which framework rules the script violates (rule number + offending block + suggested correction). Surface to the user before any prompt build. Format:

   ```
   script-framework: DEFECT
   - §1 Pattern Interrupt: opening line "..." is banned form; suggest "..."
   - §2 Duration: target is 25s (user-chosen duration) but the timeline ends at 00:15; extend to 25s
   - §3 Open Loop: 50%-mark block missing; add OPEN_LOOP at [mm:ss]
   ```

3. **AUTO-FILL** — list every default applied with rationale. Format:

   ```
   script-framework: AUTO-FILL
   - duration: 25s (from user-chosen duration; extended tier)
   - cta: "Follow for part 2" (no value provided)
   ```

PASS and AUTO-FILL are not mutually exclusive — emit both when applicable.

## User Review Gate (mandatory for every video step)

After PASS / AUTO-FILL, the script does NOT go straight into a prompt build. Output the script to the user for review FIRST.

### Closing line

After listing ALL script blocks, end the message with a confirm-or-edit ask, written in the reply language. E.g. in English: "Please review / edit the script above (including each **Text Overlay Position** — default bottom of frame, clear of the face; change it if you like), then reply 'confirm' or your edits."

### Loop rules

1. After outputting, STOP and WAIT — do NOT call `generate_video` or any other tool.
2. Only on explicit user confirm ("确认" / "OK" / "confirm" / "可以" / "go ahead") do you proceed to draft the AIGC prompt, show it to the user, and — once they confirm the prompt too — call `generate_video`.
3. If the user requests edits, re-output the FULL updated script(s) (do not patch only the changed line) and wait again — loop until confirmed.

The script shown to the user MUST state its total duration, and that number MUST equal the §2 target — the user reads this line to confirm the length they asked for was honored.

This gate applies regardless of model (Seedance 1.5 Pro / Seedance 2.0 / Seedance 2.5 / Veo 3.1 / Veo Fast) or platform. DEFECT reports surface immediately (no review gate needed — fix the defect first); only PASS / AUTO-FILL scripts reach the user review step.

## Cross-Reference

- `platform-video-style.md` → OUTER frame (platform pacing / aesthetic) for the framework-conforming script.
- `aigc-technical-prompt-builder.md` → INNER prompt (camera physics / motion / BGM / VO) for models that are neither Seedance 2.0 nor 2.5.
- `seedance-2_0-prompt-optimizer.md` → INNER prompt for Seedance 2.0 ONLY (read it yourself when the model matches).
- `seedance-2_5-prompt-optimizer.md` → INNER prompt for Seedance 2.5 ONLY (read it yourself when the model matches). Its `seedance-2_5-advanced-modes.md` companion holds the editing / extension / keyframe templates and is read only for those modes. Its "Target-Duration Override" section defers to the confirmed script's time-slices, so the §2 target duration stays intact through the prompt build.
- 2.0 and 2.5 optimizers are mutually exclusive — exactly one loads per task, chosen by the chosen model's exact version.
