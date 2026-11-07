---
name: audio-producer
description: Use for ANY audio generation task — voice-over, narration, 配音, 旁白, ad read, product read, audiobook segment, multi-speaker dialogue, interview, podcast-style exchange, background music, BGM, ambience, sound effects, speech over a music bed, subtitle-aligned audio, or binding a voice from reference audio or a reference image. Router — loads the model-specific prompt compiler that turns the script into a submit-ready audio step prompt plus its audio fields.
---

# Audio Producer — Router

Router for any audio-generation task. Read the model sub-skill before writing any audio step prompt.

## Sub-skill index

| File | When to load | Model-matched load |
|------|--------------|----------------------|
| [seed-audio-pe.md](./seed-audio-pe.md) | Every audio step whose model is Seed Audio 1.0 — compiles the script, direction, sound sources and reference bindings into ONE submit-ready prompt and decides the audio fields. | **Forced** when the audio model ∈ {seed audio, seed-audio, seed audio 1.0, seed-audio-1.0} |

## Loading rules

- **Read the model sub-skill in full** (no `limit` / `offset`) before drafting any audio step prompt. Check the audio models with `list_media_models` (type=audio): use `seed-audio-pe` when the chosen model is Seed Audio 1.0 (alias like `seed-audio-1.0`). Other audio models (e.g. `minimax-speech-2.8-hd`, preset `voice_id`, no reference audio) have no sub-skill — write a plain spoken-text prompt and set their params from `list_media_models`.
- **One audio step = one audio file** of at most 120 seconds. Never split one script across several steps; an over-long script is handled by the DURATION GATE (tell the user, do not propose).
- **Script fidelity first.** The words the user wants spoken are a quotation — never rewrite, shorten, translate or "polish" them. When you wrote the script yourself (the user gave a topic, not a script), show it to the user with the prompt — that is where they review it.
- **Music / sound effects.** Spark's audio models are speech-synthesis models; there is no dedicated music or SFX model. If the user asks for BGM, ambience or sound effects, say so first. Seed Audio 1.0 prompts can describe a sound bed, but the result is not guaranteed — continue only if the user accepts that.

## How the compiled output maps onto Spark desktop

The sub-skill was written for the raw Seed-Audio API. Here the request goes through Spark's `generate_audio` tool, so:

- **Confirm first, then generate.** Show the user the compiled prompt (and the script, voice and any parameter you set) in your reply and ask whether to generate. Call `generate_audio` only after they explicitly confirm — never in the same turn you proposed it. The tool returns immediately and the chat shows a card that updates; do not wait or poll.
- The compiled prompt body goes into `generate_audio`'s `prompt` — nothing else goes there.
- The `[Parameters]` block is NOT emitted as text. Its fields map to `generate_audio`'s `params` (string values): `speech_rate`, `loudness_rate`, `pitch_rate`, `sample_rate` (a raw value from `list_media_models`, e.g. "44100"), and `format` only when the user asks for one. There is no `enable_subtitle` here. A value the user explicitly asked for in the conversation wins over yours.
- References go in `referenceVersionIds` (versionIds from tool results or the session asset list): one to three audio versionIds — numbered `@Audio1`, `@Audio2`, `@Audio3` in array order — or exactly one image versionId (never together with audio). Put the main voice first so it is `@Audio1`.
- **Voices.** There is no Speaker ID and no voice picker. A voice is either one of the user's cloned voices (`myVoices` in `list_media_models` type=audio, or the result of `clone_voice` — pass its versionId as reference audio) or an uploaded reference recording.
- `Duration Note` / `Mode Note` / `Limit Note` / `Supplementary Suggestion` / `Additional Note` are told to the USER in your chat reply (when you show the prompt for confirmation), in the user's language — never written into the prompt. A duration overflow is not a note: it stops the proposal (DURATION GATE).
- You cannot hear reference audio. Bind each reference only by what the user says about it; never describe its timbre, accent or content.
