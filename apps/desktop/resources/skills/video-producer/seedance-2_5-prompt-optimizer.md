---
name: seedance-2_5-prompt-optimizer
description: Use when the video model is Seedance 2.5 — and ONLY 2.5. Read it yourself when the chosen model name matches (case-insensitive) seedance 2.5, seedance2.5, seedance v2.5, sd2.5, sd 2.5, 即梦 2.5, 即梦2.5. NOT for Seedance 2.0 — that model has its own optimizer (`seedance-2_0-prompt-optimizer`) with a different prompt grammar and a shorter duration cap; never load this file for 2.0 and never blend the two. Optimizes text, stories, or optional multimodal references for Seedance 2.5 text-to-video, multi-reference generation, keyframes, storyboards, blockouts, video editing, audio editing, or extension. Duration / resolution limits come from the system prompt's `videoModel capabilities` line, never from memory.
metadata:
  skill_version: 0.3.3
  owner: seedance
  tags:
    - seedance
    - prompt-optimization
    - multimodal-video
---

# Seedance 2.5 Prompt Optimizer

## Purpose

Compile the user's raw text, novel excerpts, and optional image, video, and audio references into one clean Prompt that can be submitted directly to Seedance 2.5. Preserve the user's core intent while making material roles, subject mappings, event states, and relationships to preserve explicit.

This Skill's responsibility ends with understanding the input and producing the Prompt. It must never invoke a generation API by itself. When the user explicitly asks to generate a video, first use this Skill to produce a clean Prompt, then pass it to a separate generation tool or workflow. This Skill always treats reference materials as read-only: it does not modify source materials or automatically create auxiliary materials.

## Pipeline Integration (video-producer — read before the templates)

This file is the INNER-prompt optimizer that runs AFTER `video-script-framework` (mandatory first read) and `platform-video-style`. In this pipeline:

- **Target duration is decided upstream and is NOT yours to change.** The budget is the target duration resolved by `video-script-framework` §2 (the user-chosen duration, or the length the user asked for when the model supports it). The confirmed script's `mm:ss-mm:ss` blocks already span that budget — see "Target-Duration Override" below: keep every block, keep them consecutive, and let the last block end exactly at the budget. A 25s confirmed timeline must never come out as a 15s prompt.
- **Capabilities are catalog facts.** Whatever this file says about 30-second clips, 4K, or material counts is illustrative; `list_media_models` (type=video) for the chosen model (or `list_media_models` when nothing is locked) is the only source of truth for this deployment's Seedance 2.5 options. Never tell the user a resolution or duration that line does not list.
- **The prompt body MUST be built with THIS file's templates.** A confirmed script arrives in `video-script-framework`'s review format — `[mm:ss-mm:ss] BLOCK` with `- Visual:` / `- Narration / VO:` / `- Text Overlay:` bullets. That is the REVIEW format, not the prompt format: pasting those blocks into the step's `prompt` field means Seedance 2.5 never receives a 2.5-shaped prompt and the whole reason this file exists is lost. Recompile them into "Video Generation Templates" below — `[Generation Goal]` / `[Reference Material Roles]` / `[Subjects and Relationships]` / `[Event Script]` / `[Maintain Consistency]` (drop the sections the task does not need), with the script's blocks becoming the consecutive time ranges or stages inside `[Event Script]`. Keep the block's function tag (HOOK / MECHANISM / RE-HOOK / OPEN_LOOP / PROOF / CTA) out of the prompt — it is a framework label, not content.
- **Verbatim carry-over tracks (framework §5).** Every block's `Narration / VO` line goes into the prompt untranslated, scoped to its time-slice, in the exact form `Narration / VO (<lang>): "<line>"`; every `Text Overlay` goes in with its exact wording, timing, and `Text Overlay Position` (default bottom safe area, clear of the face — never re-centered). Dropping or paraphrasing either is a generation-grade defect. Use `{}` for dialogue only when the script itself is dialogue; VO lines keep the `Narration / VO` label.
- **Reference assets are referenced as `@Image N` / `@Video N` / `@Audio N`.** Number this turn's reference attachments by their order of appearance in the input, starting from 1 (the same convention as `seedance-2_0-prompt-optimizer`), map story roles onto those numbers (one role per material, `[Unused Materials]` for the rest), and never expose raw asset IDs or URLs in the prompt text — the assets go into the `generate_video` call's `referenceVersionIds` (their versionIds) in that same order.
- **Prompt language.** The prompt body is English (the generation models are tuned for English input); the VO / dialogue / overlay strings stay in the script's original language.
- **One video task within the model's `duration` cap = ONE generation call**, whose `duration` field equals the budget above. Stages / time ranges are the internal layout of that single prompt — never one step per stage. Multi-step plans only when the runtime exceeds the model's largest `duration` option, for multiple platforms, or for creatively independent videos (see `video-script-framework` Hard Limits).
- **Advanced modes live in a companion file.** Video / audio editing, extension, keyframe anchors, storyboard grids and blockouts are in [seedance-2_5-advanced-modes.md](./seedance-2_5-advanced-modes.md); read it only when the task is one of those, never for plain text-to-video / image-to-video.
- **Parameter separation still holds**: do not write aspect ratio, resolution, total duration, or the audio toggle into the prompt text — they are set via the step params (`aspect_ratio` / `resolution` / `duration` / `with_audio`).

## When to Use

Load this Skill when:

- The user asks to optimize, rewrite, or complete a Seedance 2.5 Prompt.
- The user provides a rough idea, long-form plot, novel excerpt, or unstructured complex Prompt.
- The user provides images, videos, audio, file paths, or another multimodal request that requires material-role mapping.
- The user wants multi-reference generation, a long video, keyframe control, a storyboard grid, blockout rendering, video editing, audio editing, or video extension.
- The user wants to improve emotional performance, camera movement, audio, dialogue language, or a product/process demonstration.

Do not load this Skill automatically when:

- The user only asks about API parameters, pricing, quota, errors, or model capabilities and does not need a Prompt.
- The user only asks to evaluate a generated video and does not ask for a rewritten Prompt.

When the user explicitly asks to generate a video, still compile the raw input into a clean Prompt with this Skill before passing it to the downstream generation workflow. This Skill does not submit the generation task itself.

## Non-Negotiable Principles

1. **Intent first:** Do not change character identities or counts, key props, scenes, event causality, spatial relationships, the edit target, extension direction, or story outcome.
2. **Template first:** Reorganize every request with the template for the current task, even when the original Prompt is already complete. Do not merely paraphrase it.
3. **One explicit role per material:** State what to use from every material that is actually activated. List every available but unassigned material individually under `[Unused Materials]` so downstream PE does not reactivate it.
4. **User mappings first:** Never override material roles, subject names, or relationships explicitly assigned by the user. Once a slot is covered, do not add an unmentioned material merely to reinforce the same role.
5. **Ask as little as possible:** Resolve anything that can be reasonably inferred from the text, materials, and context. Ask one consolidated question only when ambiguity could change the core result and several equally plausible interpretations remain.
6. **Submit-ready content only:** The Prompt must not contain analysis, evaluation notes, experiment groups, model versions, run labels, API keys, or reasons for the rewrite.
7. **Separate parameters from creative content:** Do not write aspect ratio, total duration, resolution, frame rate, or the audio toggle into the Prompt. For ordinary generation, set them on the generation page or through the API. For video editing, first-frame or first-and-last-frame generation, and video extension, follow the task's automatic parameter-locking rules. Time ranges already written by the user are creative content and must be preserved; do not invent new numeric time ranges merely from a target duration supplied by the page or API.
8. **Do not add blanket constraints:** Do not automatically add unrequested quality or stability boilerplate, watermarks, logos, subtitles, duplicate-subject restrictions, or other generic negative constraints.
9. **Return one best version:** By default, output only the single Prompt judged most appropriate. Return multiple versions only when the user explicitly asks for a comparison.
10. **Separate facts from observations:** Character identity, age, relationships, events, and outcomes come from the user's text. Materials may contribute only directly visible or audible attributes; never promote a visual guess into a story fact.
11. **Match subject cardinality:** A single-person character sheet must not define two named characters who appear at the same time. When several single-person candidates are available, first assign one image per person; when several group candidates are available, first assign one image per group. Combine references only for multiple views of the same subject or when the material itself clearly contains the same story group.

## Input States

Determine which input state applies before processing the content.

### Text-Only Video Generation

The user provides no materials, and the text does not express a need to reference a particular person, product, scene, action, camera movement, or sound. Extract the subject, event, scene, visual treatment, camera treatment, and audio, then apply the video-generation template. Do not invent material numbers or suggest that the user add materials.

### A Reference Is Required but Missing

The user explicitly asks to "reference this character," "preserve the source video," "replace it with this product," or makes an equivalent request, but the corresponding material or location is not available. Still produce the best Prompt supported by the text; do not block on the missing material. Outside the Prompt, add at most one suggestion explaining that the mapping can be made more explicit after the material is provided.

Compare every material reference in the Prompt against the actual available-material list. If even one explicit reference is missing, treat that reference as "required but missing" even when other materials are available. Complete the Prompt with the remaining valid materials, but do not claim to have seen the missing material, guess its appearance, voice, or content, or continue referencing its nonexistent number in the Prompt. Preserve the character, event, or dialogue role that the missing material was meant to support using the user's text; omit only appearance, voice, action, or scene details that could be established solely by that material.

### Materials Are Readable

Actively inspect the images, videos, and audio supplied by the user. Inventory all materials first, then establish mappings in combination with the Prompt. Do not infer content from filenames alone, and do not force every material into the Prompt.

### The Current Agent Cannot Read the Materials

The user provides an attachment, path, or URL that the current runtime cannot access. Do not pretend to have inspected it. Continue optimizing everything that can be confirmed from the text, and identify which materials could not be read. Request access or confirmation only when the inaccessible item is the sole core subject reference, sole editing master, or sole source video for extension.

Skip and list a damaged or unreadable non-core material by number; continue processing the rest of the request.

### Material-Specification Preflight

Distinguish hard input limits from stability recommendations:

- Up to 30 images, each no larger than 4K.
- Up to 10 videos, with a combined duration of no more than 30 seconds.
- Up to 10 audio clips, with a combined duration of no more than 30 seconds.
- Up to 50 reference materials across images, videos, and audio combined.

Recommended ranges are not hard limits. Prefer 1-8 distinct subjects across subject-reference images; 1-5 distinct subjects across subject audio/video, with 5-10 seconds per clip; and, for video editing, a source video under 20 seconds with 1-5 reference images. When the input exceeds a recommendation but remains within the hard limits, continue optimizing rather than blocking because there are many materials. Reduce cross-contamination through one-role-per-material declarations, subject mapping, and scene-based activation.

When the input exceeds a hard limit, prioritize materials explicitly selected by the user, materials that cover required entities, the sole editing master or extension source video, and critical action, audio, or boundary-frame materials. Omit the rest from the Prompt, then append one `Material Note:` after the Prompt explaining which material type or numbers must be reduced before submission. Never claim that Prompt wording can bypass an input limit.

## Core Workflow

### 1. Parse the User's Goal

Build a "story contract" from the user's text before inspecting the materials. Extract and lock:

- Subjects and subject count.
- Actions, events, and causal order.
- Scene, time, weather, and spatial relationships.
- Prop ownership, handoffs, and final states.
- Visual style, camera, audio, dialogue, and subtitle requirements.
- Content the user explicitly requires or excludes.
- Whether the primary task is generation, editing, or extension; whether generation uses keyframes, a storyboard grid, or a blockout; and whether an editing task modifies audio only.

The story contract is the factual boundary for every later rewrite. Do not replace, merge, or delete a character or event from the story contract merely because a material contains a more visually prominent person, outfit, prop, or scene.

Preserve the meaning of the user's notation. `Shot 45`, `shot 45`, and equivalent forms refer to a shot number by default, not a `45-degree camera angle`. Interpret the number as a camera angle only when the user explicitly writes "45 degrees" or an equivalent photographic angle. Never rewrite a shot number, material number, chapter number, or step number as a camera parameter.

Whenever the input contains speech, dialogue, narration, or an audio role, build an internal "dialogue ledger" for every stage. Record the speaker, whether the speaker is vocalizing, the exact dialogue, the audio role, the language, and whether the voice is on-screen or off-screen. Do not turn a segment with a specified speaker or audio role into silence, and do not swap speakers or audio references. If the user explicitly requires a character to speak with a bound audio reference but supplies no dialogue text, or the current environment cannot transcribe it reliably, preserve that character's responsibility to speak using the reference audio without inventing dialogue.

When the user provides only a quoted fragment, keyword, or short phrase, treat only that fragment as speakable text. You may add the speaker's expression, action, and delivery, but never invent a complete sentence before or after it. When the user describes only a speaking intention such as "assert authority" or "continue arguing" without providing any exact words, do not invent dialogue. Express the intention through observable mouth movement, pauses, posture, and the other character's reaction.

For example, if the input says only that she says "You're an outsider" with an intimidating sense of status, the final dialogue may contain only `{You're an outsider.}` Do not splice narrative explanations such as "family relationship" or "status pressure" into the line, and do not expand it into "You're an outsider. What right do you have..." or any other full sentence.

Create a "required-entity checklist" for the story contract, with one slot for every explicitly present character, group, key prop, and scene. This checklist is for internal verification only and must not be shown to the user. Record each slot's story role, activated materials, and observable attributes, then confirm before output that every slot appears in the Prompt.

Translate internal thoughts into visible actions, expressions, dialogue, or narration without adding a story-changing event.

For a causal-reveal shot in which a character changes expression or behavior only after a cause appears, show the trigger clearly before showing the reaction. When trigger and reaction are spatially separated, connect them with one explicit shift of gaze or camera. When both can fit in one frame, preserve the trigger and reaction in the same composition. Do not push into a face-only close-up before the audience can see the trigger, and do not show only the reaction while omitting its cause.

When the plot explicitly depicts pretending to be hurt, simulated injury, or a near miss, state an observable uninjured condition in any ambiguous shot: for example, intact skin, clothing, and props. Do not rewrite acting or an event that did not occur as a real wound, bleeding, or damage.

### 2. Compile Novels and Long-Form Text

First convert the text into filmable events:

- When the user asks for a trailer, overview, or ensemble piece, choose a montage structure that summarizes the theme.
- When the user asks for one scene, preserve the core events that occur continuously within that scene.
- When the user does not specify a range, select one causally complete main event that can fit in the target video, and briefly disclose the selection outside the Prompt.
- Ask one consolidated question only when several mutually exclusive main threads are equally important and the choice would change the core story.

Compress repeated descriptions and information that cannot be represented on screen. Preserve character relationships, key dialogue, trigger events, and the ending state.

### 3. Inventory and Understand the Materials

For a large material set, use a two-pass review:

1. In the first pass, inventory every material lightly and identify candidates for characters, products, props, scenes, actions, camera movement, pacing, audio, and style.
2. In the second pass, inspect in depth only materials that match the story, conflict with another candidate, act as keyframes, or will be activated in the current scene.

When inspecting a video, confirm at minimum its subjects, main action, camera changes, opening state, and ending state. When inspecting audio, confirm at minimum its sound type, voice characteristics, language, dialogue content, or ambience role.

Separate two kinds of information:

- **Story assignment:** A character's name, age, relationships, event role, prop ownership, and outcome. These come from the user's text.
- **Material observation:** Directly visible or audible attributes such as facial features, hairstyle, clothing, material, color, spatial layout, action, camera movement, and voice characteristics.

Materials may supply only directly observable attributes. Do not infer or rewrite identities, ages, relationships, or plot from appearance. Do not invent a brand, color, profession, personality, or prop function that the material does not establish.

When the user calls someone only a "person" or "subject," retain that neutral term. Do not rename the subject a dancer, actor, worker, or another identity based on action, posture, or clothing. Reuse a character name or role only when the user has supplied it.

Forms of address, rank, profession, and relationships define story slots; they do not automatically imply a young, old, vulnerable, dominant, or otherwise characterized appearance. Include such attributes only when the user's text states them explicitly or when the material shows a directly observable manifestation.

By default, describe only facial features, hairstyle, clothing, accessories, and directly observable posture from a character reference. Do not replace observable detail with summary labels such as "girlish," "mature," "fragile," or "dominant." When the user explicitly requests those performance directions, translate them into expressions, posture, and actions.

Use this fixed mapping priority:

```text
User's explicit assignment > Prompt description > Material content > Filename and metadata > Upload order
```

When the user's explicit mappings cover all required entities, leave every other available but unmentioned material inactive by default. Do not infer a second character, second scene, or auxiliary reference merely because its content is similar, and do not add an unmentioned material to reinforce an already covered role. Generic background guests, furniture, decoration, and environmental elements do not create a material gap; the selected scene material and text description cover them. Evaluate an unmentioned material only when the user explicitly asks the Agent to select from all materials, asks to combine multiple references, or leaves a required core character, prop, scene, action, or sound without a source. Still list all default-inactive numbers under `[Unused Materials]` in the Prompt.

Upload order is not semantic evidence of identity or role; it normally serves only to create stable numbering. Use upload order as a final stable tie-breaker only when the user requests a direct answer, all candidates are equally plausible, and the number of story slots equals the number of candidates. Pair them one to one according to the first appearance of story slots and the order of candidate materials. This ordering resolves assignment stability only; it does not prove identity and must not be used to add an unconfirmed age, relationship, or personality.

If the input is JSON or long-form text containing Asset IDs, assign `@Image N`, `@Video N`, and `@Audio N` in each media type's order of appearance, then replace the Asset IDs in the text with those references. The final Prompt must not expose raw Asset IDs.

If only local paths are available and no reference tags exist, assign stable aliases by media type and in the order provided by the user. Under "Material Understanding," list each path and alias. Use those aliases in the final Prompt and remind the downstream uploader to preserve the same order.

### 4. Establish Material Roles and Subject Mappings

Every activated material must have one explicit role:

- Images: character appearance and clothing, product structure and material, props, scene layout, lighting, or keyframes.
- Videos: actions, camera movement, pacing, timeline, or the sole editing master or source video for extension.
- Audio: a specified speaker's voice and dialogue, ambience, sound effects, or music.

Before mapping, check every character, prop, and scene required by the story. Then follow this order:

1. Take the next unassigned character, group, prop, or scene from the required-entity checklist.
2. Review all material candidates and compare subject count, clothing layers, silhouette, structure, props, and scene role. Do not stop after finding the first usable material.
3. Select the best match for the current slot, then move to the next slot. Different named characters or groups should use different best-matching candidates by default.
4. Perform an omission audit: every required entity must have exactly one explicit role in the Prompt, and every activated material must perform only its declared role.
5. Subtract assigned materials from the complete available-material list. If the remainder is nonempty, add `[Unused Materials]` immediately after the material-role section. List every unused number by media type and state explicitly that these materials do not define people, scenes, props, actions, camera treatment, or audio. Do not explain unused materials only outside the Prompt, and do not replace explicit numbers with "other materials."

Do not merge two named characters into one subject or omit a character because its material is less visually prominent. When distinguishable candidates are available, do not reuse one material for several named characters or groups. Reuse is allowed only when the material itself clearly contains those characters together and no better independent candidates exist. When several materials jointly define one entity, say so explicitly. Materials not invoked by the story may remain unused.

In the final material-role section, each line must define exactly one subject, group, prop, or scene and its primary reference. Do not compress multiple subjects and materials into a range mapping such as "Characters A and B reference @Images 1 and 2." Split it into "Character A references @Image 1" and "Character B references @Image 2."

If two core identities have no appearance clues in the text and their candidate materials are equally plausible, do not pretend that the hidden answer can be inferred from the images. Ask one consolidated question under "Handle Mapping Confidence." If the user requests a direct output based on a reasonable assumption, apply the stable tie-breaker above to create a conservative one-to-one mapping, and avoid adding unconfirmed differences such as age or personality.

When one subject has several references, state the view or attribute contributed by each material and make clear that all of them define one entity rather than multiple copies.

Bind distinct subjects one by one, for example:

```text
<Character A> corresponds to @Image 1. Use only the facial features, hairstyle, and clothing.
<Character B> corresponds to @Image 2. Use only the facial features, hairstyle, and clothing.
<Prop A> corresponds to @Image 3. Use only the structure, material, and color.
<Scene A> references @Image 4. Use only the spatial layout, architecture, and lighting. Do not use the people in the image.

[Unused Materials]
@Images 5 and 6 are not used in this task and must not define people, scenes, props, actions, or camera treatment.
@Audio 2 is not used in this task and must not define dialogue, voice characteristics, ambience, sound effects, or music.
```

Do not replace one-to-one character mappings with a range sentence.

When a reference video's role is unspecified, select only the task-relevant dimensions from action, camera movement, pacing, scene, and audio. A generation task must not inherit the video's character identity, clothing, or entire scene by default. When the reference video already defines the action, camera movement, and sequence accurately, state only which dimensions to inherit; there is no need to restate every action. Repeating the action may conflict with the reference itself.

When written dialogue conflicts with the content of reference audio, the user's text controls the words. By default, the audio supplies only voice characteristics, accent, speed, and emotion. The exception is when the user explicitly asks to reuse the audio's dialogue.

When several references for the same subject conflict, first follow the user's assignment. If the user has not specified one, assign appearance, clothing, structure, or material to the best reference based on clarity and story fit. Ask for clarification only when the core identity still cannot be determined.

### 5. Handle Mapping Confidence

- **High confidence:** Map automatically and continue.
- **Medium confidence:** Use the most reasonable mapping and disclose the key assumption under "Material Understanding" outside the Prompt.
- **Low confidence without core impact:** Do not use the material and do not ask the user.
- **Low confidence affecting core identity, count, prop ownership, front/back, left/right, facing direction, edit target, sole master video, extension direction, or keyframe role:** Consolidate the related ambiguity into one short question.

If a user-defined mapping visibly conflicts with material content, still follow the user's mapping. Confirm once only when the conflict would almost certainly produce the wrong result.

Do not interrupt the user over missing style, lighting, ordinary camera movement, image quality, or other details that can be decided conservatively from context.

When clarification is required, ask one consolidated question and stop. Do not also output a temporary Prompt that could mislead downstream submission. After the user answers, resume from mapping and task routing. Adopt an assumption and disclose it outside the Prompt only when the user explicitly asks for a version based on a reasonable assumption.

If the user provides materials without any generation, editing, or extension goal, ask once for the minimum creative goal. Do not invent a story from the materials.

### 6. Select One Primary Task

Select exactly one of the three primary tasks. First determine whether the request modifies an existing video. If not, determine whether it generates content before or after an existing video. All other requests are generation:

1. **Video editing:** Use one source video as the sole editing master and modify only specified objects, regions, or audio.
2. **Video extension:** Generate a new continuous segment before or after the source video without rewriting the original segment.
3. **Video generation:** Generate a new video from text and optional reference materials.

Multi-reference organization, long videos, time ranges, keyframes, storyboard grids, blockouts, audio, emotion, and cinematography are composable modules, not new primary tasks. Re-rendering a blockout as a reference for action, space, or complete structure is video generation; the presence of a video input does not automatically route it to video editing.

When the user requests both editing and extension, do not discard either operation or force both into one Prompt:

- If replaced content must continue from the original video into the new segment, edit the source video first to create a new master, then extend the edited master.
- If a new subject appears only in the extended segment and does not modify the source video, perform only extension and define the new material's role for the extended segment.
- If several equally plausible operation orders remain, ask one consolidated question.

When two sequential operations are clearly required, output a two-step execution Prompt. They are consecutive steps of one request, not alternative versions.

### 7. Apply Task-Parameter Rules

These rules are for planning and notes only. Do not write them into the final Prompt:

- **Ordinary video generation:** Aspect ratio and total duration are set on the generation page or through the API. They may inform composition and event density.
- **Video editing:** Editing automatically locks the input video's aspect ratio and approximate duration; neither can be set separately. Input-frame processing may cause the output duration to differ from the source by up to approximately 0.3 seconds.
- **First-frame or first-and-last-frame generation:** The output aspect ratio is locked to the first image, while duration can be set. The first and last images should use the same aspect ratio. When the current Agent can read the images, verify the ratios proactively; when it cannot, do not pretend they were checked.
- **Video extension:** Extension automatically locks the input video's aspect ratio, while extension duration can be set.

When the user asks to set a parameter automatically locked by the task, do not ask a question, write the request into the Prompt, or use it for incorrect planning. Still produce the best Prompt first, then append at most one `Parameter Note:` after it. Use the same note when the first and last images have mismatched aspect ratios, explaining that they should be adjusted to the same ratio before submission to avoid stretching the last frame. Output no parameter note when there is no conflict.

### 8. Apply the Template and Clean the Prompt

Select the corresponding template below and retain only the sections required by the current task. Replace every `<placeholder>` with concrete content; never leave template instructions in the final Prompt.

Afterward, run the "Final Checklist" and deliver according to the "Output Contract."

## Video Generation Templates

### Basic Generation

Use this for text-only requests or simple events with few references:

```text
<Subject> performs <primary action or event> in <scene and environment>.
The visuals feature <visual style or emotion>.
Use <shot size, camera angle, camera movement, or cuts>.
Audio includes <dialogue, ambience, sound effects, or music>.
```

Delete any visual, camera, or audio line that the task does not need, but always make the subject and primary action or event explicit.

Example:

```text
A young ceramic artist throws clay in a studio at dawn, steadily supporting the spinning clay with both hands until it becomes a narrow-necked vase.
Soft morning light enters through the window on the left. The wooden table and clay retain natural warm tones.
Begin with a medium shot of the artist's hands, then slowly push in toward the mouth of the vase.
Retain the low hum of the wheel, the sound of palms rubbing wet clay, and distant birds outside the window.
```

### Generation with Reference Materials

```text
[Generation Goal]
Generate <video type or core event>. The central subject is <subject>, and the primary event is <summary>.

[Reference Material Roles]
@Image 1 defines <subject>'s <appearance, clothing, structure, or material>.
@Video 1 defines <action, camera movement, or pacing>. Do not use <identity, clothing, or scene likely to carry over unintentionally>.
@Audio 1 defines <character or sound type>'s <voice characteristics, dialogue, ambience, or music>.

[Unused Materials]
@Image 2, @Video 2, and @Audio 2 are not used in this task and must not define people, scenes, props, actions, camera treatment, or audio.

[Subjects and Relationships]
<Subject A> corresponds to @Image 1 and always retains <fixed attributes>.
The spatial, prop, or identity relationship between <Subject A> and <Subject B> is <relationship>.

[Event Script]
Opening state: <state of characters, props, and scene>.
Primary event: <continuous action or event>.
Ending state: <character positions, prop ownership, or final visible state>.

[Maintain Consistency]
Keep <character identities and count, clothing, prop ownership, spatial direction, and audio relationships> consistent.
```

Do not invent visual style, camera movement, or audio merely to fill the template. For a simple task, adjacent sections may be combined, but the role of every activated material must remain explicit.

Example:

```text
[Generation Goal]
Generate a video of a carpenter repairing an old wooden chair. The carpenter first inspects the loose backrest, then applies wood glue and secures the joint. At the end, the chair is stable again.

[Reference Material Roles]
@Image 1 defines the carpenter's facial features, short hair, and dark blue work apron. Do not use the image background.
@Image 2 defines the old chair's curved backrest, dark wood grain, and worn areas. Do not use the person in the image.
@Video 1 defines the hand movements for applying glue and pressing the joint closed. Do not use the person's identity, clothing, or workbench from the video.

[Subjects and Relationships]
The carpenter always wears the dark blue apron defined by @Image 1. The entire video contains only one old wooden chair as defined by @Image 2. The tools remain on the right side of the wooden worktable.

[Event Script]
At the start, the chair is centered on the worktable and the backrest joint is loose. After inspecting the joint, the carpenter applies wood glue and presses the backrest into place with both hands. At the end, the carpenter releases both hands, the backrest remains secure, and the chair's count and appearance remain unchanged.

[Maintain Consistency]
Keep the carpenter's identity and clothing, the chair's structure and count, the tool positions, and the workshop orientation consistent.
```

## Multi-Reference Organization

Organize multiple reference materials in this order:

```text
Define Each Material's Role -> Map Subjects -> Group by Type -> Create Subject Profiles -> Select References by Scene
```

A large material set does not mean every material belongs in the Prompt. Activate only materials relevant to the current story and scene. Put every actually available but unassigned material under `[Unused Materials]` inside the Prompt, list each number explicitly, and prohibit its activation. Unused images, videos, and audio may each be combined into one compact line, but no number may be omitted and the line must not become a range-based subject mapping.

Seedance 2.5 accepts up to 50 reference materials. Even near the limit, classify every item individually by character, prop, scene, action, and audio, then activate materials by scene. Do not use one umbrella sentence that asks the model to allocate roles by itself, and do not make every material appear at once merely to demonstrate quantity.

### Group by Type

```text
[Characters]
<Character A> corresponds to @Image 1. Use only the appearance, hairstyle, and clothing.
<Character B> corresponds to @Image 2. Use only the appearance, hairstyle, and clothing.
Do not interchange the two characters' appearances, clothing, actions, positions, or dialogue.

[Props]
<Prop A> corresponds to @Image 3 and belongs only to <Character A>.
<Prop B> corresponds to @Image 4 and belongs only to <Character B>.

[Scenes]
<Scene A> references @Image 5. Use only the space, materials, and lighting.
<Scene B> references @Image 6. Use only the space, materials, and lighting.

[Motion and Audio]
@Video 1 defines <Character A>'s <action or camera movement>. Do not use the people or scene from the video.
@Audio 1 defines <Character B>'s <voice characteristics and specified dialogue>.
```

### Subject Profiles and Scene-Based Activation

```text
[Subject Profile: Character A]
Appearance and clothing: @Image 1.
Fixed prop: <Prop A> from @Image 3.
Allowed locations: <Scene A> and <Scene B>.
Motion reference: <action> from @Video 1.
Do not use: <other subjects' clothing, props, or audio>.

Scene 1 | <Scene Name>
Use: <subjects, props, scene, motion, and audio activated in this scene>.
Event: <one primary event>.
End state: <observable state>.

Scene 2 | <Scene Name>
Use: <subjects, props, scene, motion, and audio activated in this scene>.
Event: <one primary event>.
End state: <observable state>.
```

For multiple views of one subject, define the role of each image separately, such as front, left, right, and rear views, and state the number of entities that must appear in the output.

### Space and Blocking

Describe inside/outside, front/back, facing direction, distance, and separating structures relative to stable objects such as doors, tables, vehicles, counters, and roads. Do not rely only on screen-left or screen-right. For example:

```text
<Store Clerk> always stands on the inner side of the glass counter, facing outward. <Customer A> and <Customer B> stand side by side outside the counter and speak to <Store Clerk> across it.
```

When the user provides a clean blocking diagram, use it for composition, character positions, facing directions, and spatial relationships. Do not reproduce arrows, annotation boxes, or explanatory text from the diagram in the output video.

Multi-reference example:

```text
[Characters]
<Inspector> corresponds to @Image 1. Use only the facial features, short hair, and orange windbreaker.
<Archivist> corresponds to @Image 2. Use only the facial features, glasses, and gray knitted cardigan.
Do not interchange the two characters' appearances, clothing, actions, or dialogue.

[Props]
<Portable Data Recorder> corresponds to @Image 3 and belongs only to <Inspector>. There is only one recorder throughout.

[Scenes]
<Mountain Observatory> references @Image 4. Use only the building structure, metal platform, and overcast lighting.
<Records Room> references @Image 5. Use only the shelf layout, wooden table, and warm interior light.

[Motion and Audio]
@Video 1 defines the action of <Inspector> opening the equipment bay and removing the memory card. Do not use the person or scene from the video.
@Audio 1 defines <Inspector>'s voice characteristics and dialogue.

[Event Script]
Stage 1: <Inspector> stands alone in front of the equipment bay at <Mountain Observatory>, with <Portable Data Recorder> attached at the waist. The inspector opens the equipment bay and removes the only memory card. End state: the memory card is only in <Inspector>'s right hand.
Stage 2: Inside the observatory, <Inspector> inserts the memory card into <Portable Data Recorder>. End state: the recorder screen shows that data reading is complete, and the memory card remains inside the recorder.
Stage 3: Cut to <Records Room>. <Archivist> stands on the inner side of the wooden table, while <Inspector> stands on the outer side. <Inspector> places the recorder in the center of the table and says in natural conversational English: {This week's observation data has been exported.}
Stage 4: <Archivist> picks up the recorder and checks the data while <Inspector> listens with the mouth naturally closed. End state: the recorder is only in <Archivist>'s hands.
Stage 5: <Archivist> places the recorder back on the table. Both characters look at the completion status on the screen. End on a medium shot with clear identities, prop count, and blocking.

[Maintain Consistency]
Keep the two characters' identities and clothing, the recorder's count and ownership, the spatial orientation of both scenes, and the speaker relationship consistent.
```

## Long Videos and Time Ranges

Seedance 2.5 supports videos up to 30 seconds long. Total duration is set as a generation parameter; the Prompt is responsible only for organizing events within that duration.

Numeric event ranges explicitly written by the user are creative content and must be preserved. Parameter separation removes only interface settings such as "generate a 20-second video" or "use a 16:9 aspect ratio." If the user's existing numeric ranges conflict with the target total duration on the page or API, preserve event order, relative pacing, and story outcome, then reorganize the content into nonnumeric stages. Retain the numeric ranges only when the user explicitly states that they are hard constraints, and ask the user to resolve the parameter conflict.

For a long video, prefer stages. Give each stage only one primary state change and state its ending condition:

```text
[Stage 1]
Opening state: <initial state>.
Primary event: <one primary action or event>.
End state: <observable state>.

[Stage 2]
Continue from the previous stage: <state that must remain unchanged>.
Primary event: <one primary action or event>.
End state: <observable state>.

[Stage 3]
Primary event: <closing event>.
End state: <final visible state>.
```

The number of stages follows the number of events; it may increase or decrease and is not fixed at three. For a long Prompt, preserve subject mappings, material roles, events, and ending states first. Compress repeated style words, repeated constraints, and inactive-material descriptions. Do not impose a fixed word limit.

### From a Confirmed Shot List to `[Event Script]`

An upstream-confirmed shot list is recompiled, not pasted. Each block becomes one consecutive time range whose sentence carries the action, then the block's spoken line and on-screen text verbatim:

```text
[Event Script]
0-3 seconds: opening state: <what the frame shows>; <the block's primary action>; end state: <observable state>. Narration / VO (zh-CN): "<exact line from the block>". Text overlay: "<exact wording>" at <position from the block> from 0s to 3s, synchronized with the VO.
3-8 seconds: continue from <previous state>; <primary action>; end state: <observable state>. Narration / VO (zh-CN): "<exact line>". Text overlay: "<exact wording>" at <position> from 3s to 8s, synchronized with the VO.
```

Keep the ranges consecutive and non-overlapping, and let the last one end exactly at the target duration. Never emit the review-format bullets (`- Visual:` / `- Narration / VO:` / `- Text Overlay:`) as the prompt body.

### Target-Duration Override

When a target duration supplied by the generation page or API is longer than the user's existing event timeline, first preserve the characters, event order, causality, and story outcome, then redistribute the pacing of existing events. When the duration comes only from the page or API, use nonnumeric stages so they collectively fill the narrative capacity of the target duration. Do not invent ranges such as `0-8 seconds` or `8-18 seconds` in the Prompt merely to match that parameter.

When an upstream script gate has already produced a shot list the user reviewed and confirmed, its consecutive `mm:ss-mm:ss` blocks count as numeric ranges supplied by the user: preserve every block, keep them consecutive and non-overlapping, and let the last block end exactly at the target duration. Never drop trailing blocks and never rewrite a confirmed 25-second timeline as a 15-second one — a timeline that stops short of the target leaves the remaining footage unplanned while the user still pays for it. If a confirmed timeline and the target duration genuinely disagree, state the conflict in one parameter note outside the Prompt instead of silently shortening either one.

You may lengthen only the progression of an action, a reaction, a pause, or a scene transition: for example, allow a shift of gaze, change in breathing, pickup motion, or reaction after entering to unfold naturally. Do not add a character, main plot event, or new story outcome, and do not mechanically fill time with repeated motion or empty establishing shots. Do not write the target duration itself as an interface parameter sentence in the Prompt.

For handoffs, pickups, and placements, state the ownership change of the single object. After a handoff, the original holder no longer possesses it; at the end, it is only in the recipient's hands.

Use consecutive integer time ranges only when the user already supplied numeric ranges or explicitly asks to control a handoff, entrance/exit, or beat with time ranges. Do not split sparse events merely to create more ranges; when there are too many events, merge secondary events first:

```text
0-5 seconds: <opening state>; <primary event>; end state: <observable state>.
5-10 seconds: continue from <previous state>; <primary event>; end state: <observable state>.
10-15 seconds: <closing event>; end state: <final state>.
```

When the user requests numeric ranges, make them consecutive and non-overlapping. They are event budgets, not frame-accurate edit points. Do not claim 0.5-second precision or state an unverified maximum number of ranges. If the sequence is too dense, reduce the number of stages instead of subdividing further.

Overall output duration is still set as a generation parameter. Do not also write "generate an N-second video" in the Prompt.

## Advanced Modes (separate file)

Video editing (and audio-only editing), video extension, keyframe anchors (first frame / first+last frame / multi-keyframe), storyboard grids and blockout re-rendering have their own templates in [seedance-2_5-advanced-modes.md](./seedance-2_5-advanced-modes.md).

Read that file ONLY when the task is one of those modes — i.e. the task edits or extends an existing video (a source video arrives in the step's `referenceVersionIds` (a video versionId)), or the user asks for first / last frame control, a storyboard grid, or a blockout re-render. A plain text-to-video or image-to-video generation — the common case — is fully covered by the templates above and must NOT read it. Everything in this file (story contract, material roles, `[Unused Materials]`, Output Contract, Final Checklist) still governs those modes.

## Emotion, Cinematography, and Audio

### Emotion and Observable Performance

Writing only a direction such as tense, warm, or oppressive gives the model room to interpret the specific performance. When the user needs tighter acting control, use:

```text
Emotional or atmospheric direction + Triggering event + Observable performance + Observable camera, lighting, or audio change
```

Select a small number of the clearest cues from eye movement, brow tension, mouth movement, breathing, gaze direction, hand movement, and posture. Do not pile on every possible micro-expression. Organize performance by triggering events only when the emotion changes several times.

```text
The overall emotion shifts from <starting emotion> to <ending emotion>.
After <triggering event>, <subject> first shows <immediate observable reaction>.
Then, <eyes, brows, mouth, breathing, gaze, or hand movement> gradually <changes>.
Finally, <subject> expresses <target emotion> through <outward behavior>.
```

Example:

```text
The overall emotion shifts from restrained anticipation to an effort to remain composed after disappointment.
When a server places a returned letter on the table, the woman's fingers suddenly stop tracing the rim of the cup, and her gaze settles on the return mark on the envelope.
Her brows draw together slightly, the faint smile at the corners of her mouth gradually disappears, and after a slow breath she turns the envelope face down on the table.
Finally, she looks up at the empty chair opposite her, keeps her shoulders straight, and says in a calm but slightly tightened voice: {I understand.}
```

### Professional Cinematography

Basic camera language and popular camera techniques can be written directly into the Prompt. When the frame contains several subjects, still state which subject the camera follows or revolves around, where the movement begins, and where it ends. Do not write a detached camera term without a target.

```text
Popular camera technique + Target subject + Starting position or state + Movement direction + Destination position or state
```

Popular techniques include a one-take shot, dolly zoom, aerial view, FPV, bullet time, handheld camera, and bounce speed ramp. For a one-take shot, state the subjects, spaces, and events the continuous camera passes through in order. For handheld camera, state the subject being followed and the amount of shake. For a bounce speed ramp, state where the action accelerates, decelerates, or rebounds and its final resting state.

For a niche cinematography term, a term with inconsistent industry usage, or a term that requires precise control of the image change, keep the term itself and expand it into an observable result:

```text
Cinematography term + Target subject + Visual change + Foreground/background relationship + Direction or speed
```

For example, shallow depth of field should state which subject remains sharp and how the background blurs. A tracking shot should state that the camera matches the subject's speed and specify the direction of background motion blur. Rack focus should state which object loses focus, which object gains focus, and how their sharpness changes. A vignette should state that the corners darken gradually while center brightness remains natural. Focal length, aperture, and shutter values may supplement these visible results but must not replace them.

### Audio, Dialogue, and Text

Use the following syntax when content types must be distinguished explicitly:

| Content | Syntax | Example |
|-|-|-|
| Music | `()` | `(Soft piano music plays in the background)` |
| Sound Effects | `<>` | `<A bell rings in the distance>` |
| Dialogue | `{}` | `{Hello, welcome back.}` |
| Subtitles | `【】` | `【Chapter One: Departure】` |

For dialogue language, use: `Language + Optional regional variety or accent + Delivery style + Speaker + {Dialogue}`. Label each speaker separately rather than making one blanket declaration at the beginning. When English dialogue is likely to be spoken in Chinese, state at minimum that it must be spoken in English. Add a full direction such as "natural, conversational American English" or "authentic Los Angeles English" only when the user explicitly specifies that regional variety or accent, or explicitly asks for stronger reinforcement. If the user supplies only English dialogue, do not invent an American, British, or regional accent. If the user does not specify a language, do not infer Mandarin, a dialect, or a regional accent from the script's written form. When subtitles are not required, also state that no subtitles appear on screen.

For multi-speaker dialogue, bind the speaker and audio reference within each stage and state that the other characters listen with their mouths naturally closed. Describe the source of ambience, sound effects, and music separately so irrelevant audio is not treated as background music.

If the final Prompt uses `<>` to mark sound effects, do not also place subject names in angle brackets. Use plain character names so one symbol does not perform two roles.

For a no-dialogue task, constrain speech, mouth movement, sound sources, and written text together. For example: characters keep their mouths naturally closed, there is no narration, only the specified ambience remains, and no subtitles or signs appear on screen.

### Products and Real-World Processes

Convert abstract claims such as efficient, intelligent, or reliable into `Initial State -> Concrete Operation -> Observable Result`. Each stage should demonstrate only one operation or functional result while keeping product appearance, component positions, operator identity, and scene relationships consistent.

```text
Stage 1: Opening state: <initial state of the product and components>. <Operator completes one concrete action>. End state: <directly visible state>.
Stage 2: Continue from <previous state>. <Product performs one function>. End state: <directly visible result>.
Stage 3: <Operator completes the closing action>. End state: <final state of the product, components, and finished output>.
```

Example:

```text
Stage 1: At the start, the desktop humidifier is off, the water tank is empty, and the top cover lies to the right of the body. The operator removes the tank and fills it with clean water. End state: the water level remains below the maximum line.
Stage 2: The operator reinstalls the tank, closes the top cover, and presses the power button once. End state: the operator's hand has left the button, and the humidifier remains fixed in place.
Stage 3: Fine white mist flows continuously from the outlet and rises vertically without leaving water on the table. End state: the body, tank, and top cover remain intact.
```

Do not write only "show the complete process of product installation, operation, and completion." Exact screen text, formulas, and product parameters still follow the capability boundaries in the Output Contract.

## Output Contract

Match the user's language. Preserve the user's existing reference format, such as `@Image 1` or an equivalent runtime label. Do not translate or renumber an explicit reference on your own.

### Default Delivery

By default, output only the optimized Prompt body. Do not add Markdown headings, code fences, prefatory or closing explanations, or outer wrappers such as "Optimized Prompt," "Material Understanding," or "Optimization Notes." Do not instruct the model to wrap the final result in a code fence.

When the Prompt itself requires structure, retain task-internal labels such as `[Generation Goal]`, `[Reference Material Roles]`, `[Event Script]`, and `[Maintain Consistency]`. These labels are submit-ready Prompt content, not response wrappers.

When the Agent infers material mappings automatically, do not output a separate reasoning table. Write the selected mappings directly into the Prompt's material-role section, with one line stating the adopted scope of every activated material. When the Agent can access the complete material list, it must append `[Unused Materials]` inside the Prompt and list every available but unassigned material number individually. Do not explain unused materials only outside the Prompt. When the complete material list is unavailable, do not invent unused numbers.

### Partially Missing Materials

When some materials are missing, first output a complete Prompt body that no longer references the missing numbers. Then append at most one single-line suggestion beginning with `Supplementary Suggestion:` that identifies the missing number and intended role. This suggestion is not Prompt content: put it on a separate line rather than attaching it to the Prompt's final sentence. Do not split it into several suggestions or claim to have inspected the missing material.

Example: `Supplementary Suggestion: @Audio 3 was not provided. The current Prompt preserves the corresponding character and dialogue without specifying a reference voice; provide the audio to bind the voice characteristics more precisely.`

### Input and Parameter Notes

When input materials exceed a hard limit, first output a complete Prompt based on the selected materials, then append one `Material Note:` listing the material types or numbers that must be reduced before submission. Recommended ranges are not hard limits and do not trigger a material note.

When the user requests a parameter automatically locked for editing, first-frame or first-and-last-frame generation, or extension, or when the first and last images use different aspect ratios, first output the complete Prompt and then append one `Parameter Note:`. The note should state only the conflicting rule and the required pre-submission action. Do not repeat the Prompt, expand into API documentation, or write the parameter back into the Prompt.

Example: `Parameter Note: Video editing automatically preserves the input video's aspect ratio and approximate duration, so it cannot also be set to 16:9 and 20 seconds. The Prompt above follows the source video's timeline.`

### Required Capability Disclosures

Exact subtitles, formulas, signs, product specifications, or frame-level timing cannot be fully guaranteed by Prompt wording alone. Still output the best Prompt first. When genuinely necessary, append at most one `Additional Note:` explaining that prepared materials or post-production should also be used. Output no note when it is unnecessary.

For a mixed request that requires two sequential operations, output submit-ready Prompts under `Step 1:` and `Step 2:`, and state that Step 2 uses the output of Step 1 as its new master. In every other case, output one Prompt by default.

For ordinary generation, duration, aspect ratio, and other generation parameters supplied by the user may inform event density and composition, but do not write them into the Prompt. For video editing, first-frame or first-and-last-frame generation, and video extension, apply the task's automatic parameter-locking rules first and do not plan from conflicting parameters. List configurable parameters outside the Prompt only when the user explicitly asks for an invocation example.

### Complete Input-to-Output Example

User input: `Have the barista in the reference image perform a pour-over in the reference cafe, follow the action in the uploaded video, and hand the coffee to the customer at the end.`

After inspecting the three materials, the Agent outputs only this Prompt body:

[Generation Goal]
Generate a continuous video in which a barista completes a pour-over and hands the coffee to a customer.

[Reference Material Roles]
@Image 1 defines the barista's facial features, short hair, and brown apron. Do not use the image background.
@Image 2 defines the cafe's wooden counter, glass window, and warm afternoon light. Do not use the people in the image.
@Video 1 defines the pacing and wrist movement of pouring water. Do not use the person's identity, clothing, or scene from the video.

[Event Script]
At the start, the barista stands on the inner side of the counter, the customer stands on the outer side, and the dripper and serving carafe are between them. The barista pours slowly using the movement and pacing from @Video 1. After finishing, the barista returns the dripper to its holder, then uses both hands to pass the only cup of coffee to the customer. End state: the coffee is only in the customer's hands, and the barista has released the cup with both hands.

[Maintain Consistency]
Keep the barista's identity and apron, the cafe layout, inside/outside counter blocking, and coffee-cup count consistent.

## Final Checklist

Before output, confirm every item:

- One Prompt has exactly one primary task: generation, editing, or extension. A clearly mixed request has been split into two sequential Prompts, each with exactly one primary task.
- Subject identity and count, scene, prop ownership, spatial relationships, and story outcome have not changed.
- Every required character, prop, and scene in the story contract is covered. No two named characters were merged, and no material-based guess was written as identity, age, relationship, or plot fact.
- Every activated material has one unique, explicit role.
- The Prompt body contains no unavailable material number or raw Asset ID. For a partially missing material, only the single-line `Supplementary Suggestion:` after the body may name that missing number.
- Every material number in the Prompt has been compared against the actually available material list. No partially missing material is presented as inspected, and there is at most one single-line supplementary suggestion.
- Irrelevant materials are not forced into the video. When the complete material list is available, every available but unassigned material is listed individually under `[Unused Materials]`.
- No inaccessible material is presented as understood.
- Distinct characters, products, and props are mapped one by one rather than with a range sentence.
- A single-person character sheet does not define two appearing characters. When several individual or group candidates exist, one image per person and one image per group were assigned first.
- Each long-video stage contains only one primary state change and a clear ending state.
- Event time ranges explicitly requested by the user have not been removed without permission. When only an external target duration exists, existing events are redistributed with nonnumeric stages, and the parameter has not been converted into new time ranges in the Prompt.
- A confirmed upstream shot list keeps every block, and its last block ends at the target duration. No trailing block was dropped and no confirmed timeline was shortened to a remembered cap.
- An editing task defines the sole editing master, edit scope, target count, content to preserve, and timeline inheritance. An audio edit also defines changed audio, preserved audio, lip-sync timing, and all visuals.
- The current task's automatically locked aspect-ratio and duration rules are followed. A conflict produces only one parameter note outside the Prompt.
- Extension direction and boundary-frame roles are correct, and the original video is not also rewritten. Boundary image, audio state, motion direction, and continuous subjects are all covered.
- The first frame, last frame, and other reference images each have their own roles without overriding one another. A fixed frame uses the standalone exact sentence `@Image N is the first frame.` or `@Image N is the last frame.` rather than a weakened composition-reference phrase. First/last aspect ratios were checked or handled according to the inaccessible-material rule.
- Multiple keyframes define each key state in sequence without promising frame-by-frame reproduction or a static hold.
- A storyboard grid states the reading order, each panel's shot role, and which line art, annotations, or placeholders not to use.
- A blockout is identified as coarse or fine, with subject mappings, inherited information, and excluded content defined accordingly.
- Abstract emotions and cinematography terms include observable results when control is needed.
- Within every speaking stage, the speaker, vocal state, dialogue, audio role, language, and on-screen/off-screen position match the input. Speech was not turned into silence, and no Mandarin, dialect, or regional accent was invented.
- Shot numbers, material numbers, chapter numbers, and step numbers remain identifiers and were not rewritten as camera angles or other photographic parameters.
- The Prompt contains no output parameters, internal analysis, evaluation metadata, keys, endpoints, or reasons for the rewrite.
- No negative constraint unrelated to the user's request was added automatically.
- Every placeholder has been replaced. By default, the output is one complete Prompt body without Markdown headings, code fences, or surrounding explanation.

## Compatibility and Runtime Notes

- **Text-only Agent:** Process text and explicit reference labels. Do not claim to have inspected attachments or path contents.
- **Multimodal Agent:** Within runtime capabilities, inspect images, videos, and audio, then perform the two-pass material review and automatic mapping.
- **No filesystem access:** Preserve the user's existing labels and apply the "Current Agent Cannot Read the Materials" fallback to inaccessible paths.
- **No network access:** Do not attempt to resolve remote URL content or infer material content from the URL name.
- **Output only:** This Skill outputs text and requires no file writes, network access, tool calls, or binary-output capability.
