---
name: seed-audio-pe
description: Use when an audio step's model is Seed Audio 1.0. Compiles the user's text, marketing copy, scripts, and optional reference audio or image into one submit-ready Seed-Audio 1.0 prompt plus the audio step fields, for voice-over, narration, multi-speaker dialogue, background music, sound effects, or subtitle-aligned audio.
---

# Seed-Audio 1.0 Prompt Optimizer

## Purpose

Compile the user's raw text, marketing copy, scripts, and optional reference audio or image into one clean `text_prompt` that can be submitted directly to Seed-Audio 1.0, plus the audio parameters that request actually requires. Preserve the user's wording and intent while making speaker bindings, emotion, delivery, language, and sound-source roles explicit.

This Skill's responsibility ends with understanding the input and producing the prompt and its parameters. It must never invoke a generation API by itself. When the user explicitly asks to generate audio, first use this Skill to produce a clean prompt, then show it to the user and, once they confirm, pass it to `generate_audio` (see "Platform Mapping" at the end of this file). This Skill always treats reference materials as read-only: it does not modify source materials or automatically create auxiliary materials.

## When to Use

Load this Skill when:

- The user asks to optimize, rewrite, or complete a Seed-Audio prompt.
- The user provides marketing copy, a script, a rough idea, or unstructured text that needs to become spoken audio.
- The user wants voiceover, narration, a product read, an ad read, or an audiobook segment.
- The user wants multi-speaker dialogue, a scripted scene, or an interview-style exchange.
- The user wants background music, ambience, or sound effects, with or without speech over it.
- The user provides reference audio, wants one of their cloned voices (`myVoices` in `list_media_models` type=audio, or a `clone_voice` result), or provides a reference image that must drive the timbre.
- The user wants control over emotion, delivery, pacing, pauses, language, or accent.
- The user needs word-level timestamps for subtitles or for aligning audio to an existing video cut.

Do not load this Skill automatically when:

- The user only asks about API parameters, pricing, quota, errors, or model capabilities and does not need a prompt.
- The user only asks to evaluate generated audio and does not ask for a rewritten prompt.
- The user wants a video prompt. Use the video prompt Skill for that, and use this Skill only for the audio track that is generated separately.

When the user explicitly asks to generate audio, still compile the raw input into a clean prompt with this Skill before passing it to the downstream generation workflow. This Skill does not submit the generation task itself.

## Non-Negotiable Principles

1. **Script fidelity first:** Text the user wants spoken is a quotation, not a draft. Never rewrite, shorten, translate, reorder, or "improve" the words to be synthesized. Direction describes how it is said; it never changes what is said.
2. **Template first:** Reorganize every request with the template for the current task, even when the original prompt is already complete. Do not merely paraphrase it.
3. **One explicit role per reference:** State what to use from every activated reference and what not to use. List every available but unassigned reference individually under `[Unused References]` so downstream PE does not reactivate it.
4. **User bindings first:** Never override a speaker name, timbre assignment, picked voice, language, or reference role that the user assigned explicitly. Once a slot is covered, do not add an unmentioned reference merely to reinforce the same role.
5. **Ask as little as possible:** Resolve anything that can be reasonably inferred from the text, references, and context. Ask one consolidated question only when ambiguity could change the core result and several equally plausible interpretations remain.
6. **Submit-ready content only:** The prompt must not contain analysis, evaluation notes, experiment groups, model versions, run labels, API keys, or reasons for the rewrite.
7. **Separate parameters from creative content:** Sample rate, speech rate, loudness, pitch and the subtitle toggle belong in the audio step's own fields, never inside `text_prompt`. Describe perceived delivery in words inside the prompt; express the numeric setting only in the step fields.
8. **Do not add blanket constraints:** Do not automatically add unrequested quality boilerplate, subtitles, loudness normalization, or generic negative constraints. Do not enable `enable_subtitle` unless the user's request needs it.
9. **Return one best version:** By default, output only the single prompt judged most appropriate. Return multiple versions only when the user explicitly asks for a comparison.
10. **Separate facts from observations:** Speaker identity, relationships, product claims, and script content come from the user's text. References may contribute only directly audible or visible attributes such as timbre, accent, pace, or apparent age and gender; never promote such an observation into a factual claim about a real person or product.
11. **Match speaker cardinality:** One reference audio clip defines one voice. Do not bind a single clip to two speakers who both appear, and do not merge two clips into one voice unless they are clearly the same speaker. Assign one reference per distinct speaking role first.
12. **Never claim a syntax the model does not define:** Seed-Audio takes natural language. Do not import bracket conventions from video prompt Skills, invent SSML, or add markup tags. See Sound-Source Description.

## Model and Hard Limits

These come from the Seed-Audio 1.0 API contract. Treat them as hard boundaries when planning a prompt.

- **Model:** Seed Audio 1.0. It is the single current model: it covers English, Chinese, Japanese, Korean, Mexican Spanish, Castilian Spanish, Indonesian, German, Brazilian Portuguese, French, Thai, Vietnamese, Malay, Filipino, Italian, Russian, Dutch, Polish, Turkish, and Swedish, and it supports timing control. Do not route multilingual requests to a separate model.
- **`text_prompt`:** required, up to 3000 characters. This single field carries both the direction and the text to be spoken.
- **Output duration:** up to 120 seconds per audio step. It is billed by the actual output duration.
- **Reference audio:** at most 3 clips, each up to 30 seconds and no larger than 10 MB, in wav, mp3, pcm, or ogg_opus.
- **Reference image:** at most 1, no larger than 10 MB, in jpeg, png, or webp.
- **Mutually exclusive modes:** audio references (including a cloned voice) and an image reference cannot be combined.
- **Reference numbering:** `@Audio1`, `@Audio2`, `@Audio3`, numbered from 1 in the order they are sent — the order of the audio versionIds in `generate_audio`'s `referenceVersionIds`. Put the main voice (e.g. the cloned narrator voice) first so it is `@Audio1`. Write them with no space between `@Audio` and the digit. This differs from the `@Image 1` style used by video prompt Skills; do not carry that spacing over.

When a request exceeds a reference limit, still build the best complete prompt from the references that fit, and tell the user in one `Limit Note` sentence in your reply what must be reduced. Never suggest that prompt wording can bypass a limit.

## Input States

Determine which input state applies before processing the content.

### Text-Only Generation

The user provides no references. Everything — speaker character, emotion, delivery, language, ambience, music, and the spoken text — is described in `text_prompt`. This is the default state for marketing copy and narration. Do not invent reference numbers or suggest that the user add references.

### Reference-Audio Generation

The user wants a cloned voice, provides one to three audio clips, or both (at most 3 in total). The prompt keeps its full direction and spoken text, and additionally binds each `@AudioN` to exactly one role. The main voice is sent first, so it is `@Audio1`: bind it as the role the user wants it for (by default, the narrator) and refer to it by its name when several voices are in play.

### Reference-Image Generation

The user provides one image to drive the timbre. Use this mode ONLY when the user explicitly asked for the voice to be derived from the image. In this mode `text_prompt` may contain **only the text to be synthesized** — no emotion direction, no delivery notes, no music or sound-effect description, no speaker labels. Any direction the user gave cannot be honored inside the prompt in this mode. Put the bare spoken text in the prompt, and tell the user in your reply (the `Mode Note`) that image-reference mode accepts only the text to be synthesized and that the dropped direction needs a picked voice or reference audio instead. Never silently keep the direction in the prompt, and never silently drop it without telling the user.

### A Reference Is Required but Missing

The user explicitly asks to "use this voice," "match the sample," or "clone her timbre," but the corresponding clip or picked voice is not available. Still produce the best prompt supported by the text; do not block on the missing reference. Complete the prompt without referencing the missing number, do not claim to have heard it, and do not guess its timbre, accent, or apparent age. Preserve the speaking role the missing reference was meant to fill using the user's own description. In your reply, add at most one `Supplementary Suggestion` sentence identifying the missing reference and its intended role.

### The Current Agent Cannot Hear the References

On this platform you never hear reference audio: you only receive its versionId (and sometimes a file name). Inventory every reference first, then bind each one by what the user says about it. Do not infer content from file names or URLs, and do not force every reference into the prompt. Do not pretend to have inspected it. Continue optimizing everything that can be confirmed from the text and preserve the user's own labels. Never block on not hearing a reference — the audio model receives the recording itself.

## Core Workflow

### 1. Parse the User's Goal

Build an "audio contract" from the user's text before inspecting references. Extract and lock:

- The exact text to be spoken, verbatim, including brand names, numbers, prices, and punctuation.
- Speakers and speaker count, and who says which line.
- Emotion, attitude, and delivery for each speaking segment.
- Language, and any regional variety or accent the user stated.
- Music, ambience, and sound effects, and whether each is wanted at all.
- Whether the audio must align to an existing video cut, subtitle file, or fixed duration.
- Content the user explicitly requires or excludes.

The audio contract is the factual boundary for every later rewrite. Do not add a second speaker, an unrequested tagline, a call to action, a music bed, or a closing line that the user did not ask for.

Preserve the user's notation. A line label such as `VO:`, `Speaker A:`, or `Scene 2` is an identifier for organizing the script, not content to be read aloud. When a label must not be spoken, keep it as a prompt-internal structural label rather than part of the quoted text.

### 2. Select One Primary Task

Each prompt has exactly one primary task:

- **Voiceover or narration** — one speaker reads the user's copy.
- **Multi-speaker dialogue** — two or more speakers alternate.
- **Music and sound design** — music, ambience, or effects, with no speech.
- **Speech over a sound bed** — a voiceover or dialogue task that also specifies music or effects underneath. The speech template leads; the sound bed is one additional line.

When the user clearly asks for two separate deliverables, such as a narrated segment and a separate music-only sting, make them two audio steps in the same plan, each with its own prompt. In every other case, one audio step. Never use this to split one long script — see Budget the Duration.

### 3. Inventory and Bind References

List every reference before writing the prompt: its number, what the user says it is, and whether the audio contract needs it. Then bind each activated reference to exactly one role, stating both the adopted scope and the excluded scope. Typical adopted scopes are timbre, accent, pace, and emotional color; typical excluded scopes are the words spoken in the sample, its background noise, its music, and its recording space.

Do not force an irrelevant reference into the prompt. When the complete reference list is known, list every available but unassigned reference individually under `[Unused References]`.

### 4. Build the Dialogue Ledger

Whenever the input contains more than one speaking role, record for every segment: the speaker's name, the voice characteristics or bound reference, the emotion and delivery, the language, and the exact line. Then write the prompt from the ledger in segment order.

Bind the speaker inside each segment rather than declaring all voices once at the top. A single blanket declaration is the most common cause of voices bleeding into each other. State explicitly that only the named speaker is audible during that segment.

### 5. Budget the Duration

Output is capped at 120 seconds, and the cap applies to the model's own output. Estimate before writing, at `speech_rate` 0:

- English and other Latin-script languages: roughly 150 words per minute, so about 300 words fits in 120 seconds.
- Chinese and Japanese: roughly 240 characters per minute, so about 480 characters fits in 120 seconds.

Treat these as planning estimates, not guarantees. Emotional or emphatic reads, deliberate pauses, and dense numbers all run slower. Leave headroom: aim for about 85% of the cap.

When the user's script exceeds the 120-second cap, do not cut their words, do not raise `speech_rate` to compress it, and do not split it into several steps. Do not propose a plan at all: tell the user the estimated length and the 120-second limit, and ask them to shorten the copy or to have it generated in several separate requests (this is the DURATION GATE).

### 6. Apply the Template

Use the template for the selected task. Reorganize even a well-formed input into the template. Keep the spoken text verbatim inside it.

### 7. Derive the Parameters

Decide the step fields only after the prompt is written, from what the request actually needs. See Parameters Contract. Set a field only when the request gives a reason to move it off its default.

### 8. Clean the Prompt

Remove every placeholder, every note to the user, every mention of the model, and every numeric parameter. Confirm the prompt is under 3000 characters. Confirm no reference number appears that was not actually provided.

## Task Templates

### Voiceover and Narration

```text
<Speaker character: apparent age, gender, timbre, and role> delivers the following <script type> in <language>, with <emotion and attitude>.
Delivery: <pace, energy, emphasis, pauses, breath, and how the ending lands>.
<Recording character or sound bed, only if the user asked for one>
Script, to be read exactly as written:
"<the user's text, verbatim>"
```

Example:

```text
A warm, confident female narrator in her early thirties delivers the following product voiceover in English, sounding genuinely impressed rather than salesy.
Delivery: relaxed conversational pace, light emphasis on "three minutes", a short pause before the final sentence, and a downward, settled ending.
Clean studio recording with no background music.
Script, to be read exactly as written:
"Editing used to eat your whole afternoon. Now it takes three minutes. That's the whole pitch."
```

### Multi-Speaker Dialogue

```text
A <scene description> conversation in <language> between <N> speakers.
<Speaker 1 name>: <apparent age, gender, timbre, accent, and the reference binding if any>.
<Speaker 2 name>: <apparent age, gender, timbre, accent, and the reference binding if any>.
Only the named speaker is audible in each line; the others stay silent.
<Sound bed, only if the user asked for one>
Lines, in order, to be spoken exactly as written:
<Speaker 1 name>, <emotion and delivery>: "<line, verbatim>"
<Speaker 2 name>, <emotion and delivery>: "<line, verbatim>"
```

Bind emotion per line, not per speaker, whenever the emotion changes across the exchange. Keep the speaker names as labels: they are not spoken.

### Music and Sound Design

```text
<Music, ambience, or effect> with no speech and no narration.
Music: <genre, instrumentation, tempo, mood, and arc>. Omit this line if no music is wanted.
Ambience: <location, and which environmental sounds are present>. Omit this line if none.
Sound effects: <each effect, its source, and when it occurs>. Omit this line if none.
No voices, no lyrics, and no spoken words of any kind.
```

Describe each sound source separately so ambience and effects are not collapsed into background music. When the user wants no music, say so explicitly rather than leaving it unstated.

### Reference-Audio Generation

```text
[Generation Goal]
<One sentence stating the audio to produce.>

[Reference Roles]
@Audio1 defines <adopted scope>. Do not use <excluded scope>.
@Audio2 defines <adopted scope>. Do not use <excluded scope>.

[Direction]
<Language, emotion, delivery, and sound bed, as in the matching speech template.>

[Script]
"<the user's text, verbatim>"

[Unused References]
@Audio3: <what it contains and why it is not activated.>
```

Drop `[Unused References]` when every provided reference is activated, and drop it when the complete reference list is not available rather than inventing numbers.

### Reference-Image Generation

```text
<the user's text to be synthesized, verbatim, and nothing else>
```

No direction, no labels, no sound-source lines. Tell the user the required `Mode Note` in your reply whenever direction had to be dropped.

## Sound-Source Description

Seed-Audio reads natural language. Describe music, ambience, effects, and speech in plain sentences, each naming its own source.

Do not import bracket conventions from video prompt Skills — the `()` for music, `<>` for sound effects, `{}` for dialogue, and `【】` for subtitles used by Seedance prompts are **not** part of the Seed-Audio contract. Do not emit SSML, phoneme tags, pause tags, or any other markup. Express a pause as a written instruction in the direction line, or through the punctuation already present in the user's script.

Quote the spoken text with ordinary quotation marks and introduce it with a phrase such as `Script, to be read exactly as written:` so the direction is not mistaken for something to read aloud.

## Emotion and Delivery Control

Abstract emotion words drift. When control matters, pair the emotion with an audible result.

| Vague | Controlled |
|-|-|
| Excited | Bright and fast, rising at the end of each sentence, with audible smile |
| Professional | Even pace, minimal pitch movement, crisp consonants, no upspeak |
| Warm | Slightly slower than conversational, soft onsets, gentle downward endings |
| Urgent | Clipped phrasing, short gaps, emphasis on verbs, no trailing softness |
| Luxury | Slow, low, generous pauses between phrases, very little dynamic range |

Direct only what the user cares about. Two or three delivery attributes control the read; ten fight each other.

## Language and Accent

State the language explicitly whenever the script's written form could be read in more than one. Do not infer a language, dialect, or regional accent from the script's script system alone, and do not infer one from the user's own chat language.

Add a regional variety or accent only when the user specified it. If the user supplies English copy without further detail, state that it is spoken in English and stop there; do not invent an American, British, or other regional accent. In multi-speaker dialogue, state the language per speaker when they differ, and once for the whole scene when they do not.

## Parameters Contract

The parameters go into `generate_audio`'s `params` object — never into the prompt text. Values are strings; take exact raw values / ranges from `list_media_models` (type=audio). Set a field only when the request gives a concrete reason to move it off its default, and keep the reason out of the prompt. A value the user explicitly asked for overrides yours.

| Step field | Range and default | Change it when |
|-|-|-|
| `speech_rate` | int, -50 to 100, default 0. 100 is 2.0x, -50 is 0.5x | The user asked for a faster or slower read. Around +10 to +25 for an energetic ad read; -10 to -20 for a tutorial or luxury read. Never to squeeze an over-long script |
| `loudness_rate` | int, -50 to 100, default 0 | The audio must sit under a music bed, or the user asked for a quieter or louder result. Leave at 0 when downstream mixing will normalize it |
| `pitch_rate` | int, -12 to 12, default 0 | A single voice needs to read lower or brighter than the model's natural choice. Around -2 to -4 for deeper, +2 to +4 for brighter. Do not use it to separate voices in multi-speaker dialogue — describe the timbres in the prompt instead |
| `sample_rate` | one of the model's `sample_rate` values from `list_media_models` (e.g. "24000", "44100", "48000") | 24 kHz is enough for speech; 44.1 kHz or 48 kHz for music and sound design, and to match a video timeline. Omit to use the model default |
| `enable_subtitle` | not available in Spark desktop | Subtitle timestamps cannot be requested here. If the user needs captions aligned to the audio, say so in an `Additional Note` |

Output format goes in `params.format` (only when the user asks, values from `list_media_models`). Voices and references go in `referenceVersionIds`: audio versionIds in `@AudioN` order, or one image versionId for reference-image mode.

## Output Contract

Match the user's language in anything you tell the user. Write the prompt itself in the language the audio requires. Preserve the user's existing reference labels; do not translate or renumber them.

### Default Delivery

The prompt body goes into the audio step's `prompt` field — nothing else: no Markdown headings, no code fences, no wrappers such as "Optimized Prompt" or "Rewrite Notes", no parameters, no notes.

Task-internal labels such as `[Generation Goal]`, `[Reference Roles]`, `[Direction]`, `[Script]`, and `[Unused References]` are submit-ready prompt content, not response wrappers. Keep them when the template uses them.

### Notes to the User

At most one sentence each, only when the condition actually applies, in your chat reply when you show the prompt for confirmation — never inside the prompt:

- `Mode Note` — image-reference mode accepts only the text to be synthesized, so the stated direction was dropped.
- `Limit Note` — a reference limit was exceeded and what must be reduced.
- `Supplementary Suggestion` — a reference was required but not provided, and the role it was meant to fill.
- `Additional Note` — exact pronunciation, precise timing, singing, or a specific real person's voice cannot be guaranteed by prompt wording alone, and prepared material or post-production is also needed.

An over-long script is not a note: it stops the plan (see Budget the Duration).

### Complete Input-to-Output Example

User input: `Make a 30s voiceover for our new AI editor launch, punchy, English, and put some light electronic music under it. Copy: "Your first cut, in under a minute. Meet Studio. Free while in beta."`

Audio step `prompt`:

A confident, energetic male narrator in his late twenties delivers the following launch voiceover in English, sounding genuinely excited without shouting.
Delivery: brisk pace, crisp consonants, strong emphasis on "under a minute" and "Free", a short beat before the last sentence, and a decisive ending.
Music: light electronic bed with a soft pulse and muted synth chords, low in the mix and well under the voice, no lyrics.
Script, to be read exactly as written:
"Your first cut, in under a minute. Meet Studio. Free while in beta."

Audio step fields: `speech_rate` 15, `sample_rate` "44.1 kHz".

## Final Checklist

Before output, confirm every item:

- Each audio step's prompt has exactly one primary task. A genuinely two-deliverable request became two audio steps, each with one task.
- Every word the user wants spoken appears verbatim. Nothing was rewritten, translated, reordered, shortened, or polished, and no tagline, call to action, or extra line was added.
- Structural labels such as `VO:` or `Speaker A:` are not inside the quoted spoken text.
- Speaker count and per-line assignment match the input. No speaker was merged, added, or dropped.
- In multi-speaker dialogue, each segment binds its own speaker and emotion, and states that the other speakers are silent. There is no single blanket voice declaration at the top.
- Language is stated wherever it could be ambiguous. No accent, dialect, or regional variety was invented, and none was inferred from the user's chat language.
- Every activated reference has exactly one explicit role with both adopted and excluded scope. `@AudioN` is written with no space, numbered from 1 in send order (a picked voice is `@Audio1`).
- The prompt names no reference that was not provided. A missing reference produced at most one `Supplementary Suggestion` sentence to the user and no guessed timbre.
- When the full reference list is known, every available but unassigned reference is listed individually under `[Unused References]`. No unused numbers were invented when the list is unknown.
- Audio references (including a picked voice) and an image reference are not mixed.
- In image-reference mode the prompt contains only the text to be synthesized, and dropped direction was told to the user as a `Mode Note`.
- Music, ambience, and sound effects each name their own source. When the user wants no music or no speech, that is stated explicitly.
- No bracket syntax, SSML, phoneme tag, or other markup was emitted. Pauses are written as direction or carried by the user's punctuation.
- Estimated duration is within the 120-second cap — otherwise no plan was proposed and the user was told. The script was not cut, not split, and `speech_rate` was not raised to hide an overflow.
- `text_prompt` is under 3000 characters.
- Only the step fields the request justifies are set. Every value is in range: `speech_rate` and `loudness_rate` in -50 to 100, `pitch_rate` in -12 to 12, `sample_rate` from the model's list.
- `enable_subtitle` is off unless the request needs it.
- No parameter, model name, internal analysis, or reason for the rewrite appears inside the prompt body.
- No negative constraint unrelated to the user's request was added automatically.
- Every placeholder is replaced. The step prompt is the prompt body only — no Markdown headings, code fences, notes or surrounding explanation.

## Platform Mapping

- The compiled prompt is one `generate_audio` call (`model`: the Seed Audio 1.0 alias from `list_media_models`, e.g. `seed-audio-1.0`); show it to the user first, and call the tool only after they confirm.
- You cannot hear reference audio and you do not resolve URLs. Bind references only by the user's own description of them.
- This Skill never calls a generation API; generation starts only when you call `generate_audio` after the user confirms.
