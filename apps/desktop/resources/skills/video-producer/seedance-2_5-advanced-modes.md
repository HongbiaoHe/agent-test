---
name: seedance-2_5-advanced-modes
description: Seedance 2.5 templates for the non-plain-generation modes — video editing (incl. audio-only editing), forward / backward video extension, keyframe anchors (first frame, first+last frame, multi-keyframe), storyboard grids, and blockout re-rendering. Load ONLY after `seedance-2_5-prompt-optimizer` when the task is one of those modes (the step carries a source video in `referenceVersionIds` (a video versionId), or the user asks for first/last-frame control, a storyboard grid, or a blockout re-render). A plain text-to-video / image-to-video task never needs this file. Never load it for Seedance 2.0 — that model has its own optimizer.
---

# Seedance 2.5 — Advanced Mode Templates

Split out of `seedance-2_5-prompt-optimizer.md` so a plain generation task does not have to read the editing / extension / keyframe templates. Everything in the parent file still applies here: the story contract, material-role mapping and `[Unused Materials]` rules, the Output Contract, and the Final Checklist. Read the parent FIRST, then this file.

Duration, aspect ratio and resolution are still catalog facts — `list_media_models` (type=video) for the chosen model. The per-task parameter-locking rules below (editing inherits the source video's ratio and approximate duration; extension inherits its ratio; a first frame locks the ratio) describe what the VENDOR locks, and surface as a `Parameter Note:` outside the Prompt — never as a seconds value written into the Prompt text.

## Video Editing Template

Every editing task must define one source video as the sole editing master. A Prompt that describes only the target appearance degrades into regeneration and is not a valid editing Prompt.

For visual editing, first inventory every category of visible subject in the source video, including named and unnamed characters, live-action people, models or mannequins, animals, props, foreground objects, and background subjects. For every category, state explicitly whether to replace it, remove it, or keep it unchanged. Do not omit an unnamed person, model, prop, or background subject. Objects the user did not ask to modify remain unchanged by default. Include an entire category in the replacement or removal scope only when the user explicitly requests a group-level change or asks the target image to retain only specified objects.

If the current Agent cannot inspect the full source video or has only sparse previews, it must not claim to have exhaustively inventoried every object. After explicitly describing all user-specified replacements, removals, and preserved objects, add this fallback sentence: `Except for the objects explicitly modified above, all other visible people, props, and background elements in @Video 1 remain unchanged and must not be replaced or removed.` When the user explicitly asks to retain only the target objects, replace the fallback with a sentence that removes every other object as requested.

Every video-editing Prompt must include one of these two closed-scope statements:

- Local modification: `Except for the objects explicitly modified above, all other visible people, props, and background elements in @Video 1 remain unchanged and must not be replaced or removed.`
- The user explicitly requests only the target objects: `Except for the objects explicitly retained above, remove all other visible subjects from @Video 1. Do not add unspecified objects.`

The source-video inventory determines only which objects are replaced, removed, or preserved. It must not change the target material set already specified by the user. If the user explicitly assigns @Image 3 to an edit target, do not add an unmentioned image as an appearance, clothing, group, or auxiliary reference merely because it is clearer or similar. Continue listing those materials under `[Unused Materials]`.

```text
[Edit Goal]
Edit @Video 1. Change only <original object or region> to <target content>.

[Source Video Role]
@Video 1 is the sole editing master. It defines the original scene, camera position, camera movement, motion paths, occlusion relationships, and event order.

[Target Material Role]
@Image 1 defines <target subject, background, or product>'s <appearance, structure, or material>. Do not use <irrelevant background, people, or composition>.

[Edit Objects and Scope]
Modify only <explicit objects and regions>. The entire video contains <number> target object(s). Do not modify <content to preserve>.
Except for the objects explicitly modified above, all other visible people, props, and background elements in @Video 1 remain unchanged and must not be replaced or removed.

[Timeline Inheritance]
<Target object> inherits every appearance, motion, occlusion, and exit of <original object>, including timing, duration, path, and speed changes.
Keep the other character actions, camera movements, cuts, and event order from @Video 1.
```

For subject replacement, state the original and target objects. For background replacement, modify only the background outside the subject silhouette. For a local edit, state the region, attribute, and content to preserve. When adding or removing an object, state its count, position, appearance timing, and affected scope.

Dynamic subject-replacement example:

```text
[Edit Goal]
Edit @Video 1. Replace only the red bicycle and rider passing in front of the bench with the dark gray electric patrol vehicle in @Image 1.

[Source Video Role]
@Video 1 is the sole editing master. It defines the park road, the two people on the bench, camera position, camera movement, the original rider's motion slot, occlusion relationships, and event order.

[Target Material Role]
@Image 1 defines only the dark gray electric patrol vehicle's body structure, color, and clear windshield. Do not use the image background or driver.

[Edit Objects and Scope]
Remove the red bicycle and rider from the source video. The entire video contains only one electric patrol vehicle. Keep the two people on the bench, the trees, road, and background from @Video 1.

[Timeline Inheritance]
The electric patrol vehicle fills the original rider's motion slot with exactly the same appearance timing, motion path, speed, and occlusion positions. The finished video no longer contains the red bicycle or rider. Keep all other character actions, camera movements, cuts, and event order from @Video 1.
```

For a cross-category dynamic replacement, prefer "motion-slot replacement": explicitly remove the original subject, make the target subject inherit exactly the same appearance timing, motion path, speed, and occlusion positions, and state that the original subject no longer appears. Keep the preservation list focused on adjacent regions that genuinely must not change so that it does not dilute the edit target.

```text
Remove <original moving subject> that passes in front of <foreground subject> in @Video 1. Replace it at exactly the same appearance timing, motion path, speed, and occlusion positions with <target moving subject> defined by @Image 1. The finished video no longer contains <original moving subject>.
```

Use global master-video inheritance by default. Add only a few observable event conditions, and only when a pickup, handoff, placement, entrance, or exit in the source video can be observed accurately:

```text
Only after <observable completion state of Event A> appears may <Event B> occur.
Only after <observable completion state of Event B> appears may <Event C> occur.
```

Do not reconstruct time ranges from memory or add event conditions from incomplete extracted frames. Prompt wording can improve the probability that critical events follow the source timeline, but it cannot guarantee frame-by-frame overlap after editing.

### Audio Editing

When modifying only dialogue, language, voice characteristics, background music, ambience, or action sound effects, still define the source video as the sole editing master. State separately which speaker or sound category changes, the target change, the time range, and which other sounds and visuals remain unchanged. Do not redesign character actions, lip-sync timing, camera treatment, or editing rhythm merely because audio is being edited.

```text
[Edit Goal]
Edit @Video 1. Within <the entire video or an explicit time range>, <remove, replace, or adjust> <speaker or sound category> only.

[Source Video Role]
@Video 1 is the sole editing master. It defines the original visuals, character actions, lip-sync timing, camera treatment, editing rhythm, other sounds, and event order.

[Target Audio Role]
@Audio 1 defines <target speaker or sound type>'s <voice characteristics, dialogue, ambience, sound effect, or music>. Do not use <irrelevant audio>.

[Audio Edit Scope]
Modify only <explicit speaker, sound category, or time range>.

[Content to Preserve]
Keep <other dialogue, lip-sync timing, ambience, action sound effects, visuals, camera treatment, and editing rhythm> from @Video 1 unchanged.
```

When the user only asks to remove the original background music, do not invent a target audio material. State directly that the background music is removed while character dialogue, lip-sync, ambience, action sound effects, and all visuals remain unchanged. When changing dialogue language or voice characteristics, preserve the dialogue content and speaking times from the source video by default unless the user explicitly asks to rewrite them as well.

## Video Extension Templates

If the user says only "extend" and the direction cannot be determined from context, extension direction is high-impact information; ask one consolidated question.

For subjects present at the extension boundary, use only names confirmed by the user. If the user says only "person" or "subject," retain that neutral term. Do not infer a profession, performance type, or story identity from the subject's action, posture, or clothing in the source video.

Throughout the extension, each subject remains one continuous instance. Do not duplicate, split, or generate a second copy of the same subject. Keep body structure, component count, and topology consistent with the boundary frame. When a subject turns, becomes occluded, leaves the frame, or re-enters, it is still the same continuous object and must not be replaced by a new instance.

The final Prompt must state the single-instance and topology requirements explicitly. Checking them only in internal analysis is insufficient.

### Forward Extension (After the Original Video)

A forward extension generates content after the source video ends. The first frame of the new segment continues from the source video's last frame.

```text
@Video 1 is the source video to extend forward.

Extend @Video 1 forward. The first frame of the extended segment directly continues from the last frame of @Video 1. Maintain continuity in <subject pose and orientation>, <prop position>, <background and spatial relationships>, <camera position and composition>, <lighting>, <audio state>, and <motion direction>.

Then, <new action, event, camera treatment, or audio to generate beyond the boundary>.

Throughout the extension, maintain continuity in <character identity and clothing>, <key props>, <background layout>, <camera axis>, and <existing audio environment>.
Each subject remains the same continuous object without duplication or splitting. Keep character anatomy and object component counts stable.
```

Example with additional reference materials:

```text
@Video 1 is the source video to extend forward.
@Image 1 defines <Gardener>'s facial features, short hair, and light green work apron. Do not use the image background.
@Image 2 defines <Wicker Flower Basket>'s structure and material. Do not use the garden or people in the image.

Extend @Video 1 forward. The first frame of the extended segment directly continues from the last frame of @Video 1. Maintain the greenhouse workbench, <Gardener>'s position and facing direction, the wooden rack's position, the locked-off medium shot, and the afternoon side light. Other reference materials must not replace this boundary image.

Then, <Gardener> picks up <Wicker Flower Basket> defined by @Image 2 from beneath the workbench and places it with both hands on the middle shelf of the wooden rack behind them. End state: the basket is only on the middle shelf, and <Gardener> has released both hands and taken half a step back.

Throughout the extension, keep <Gardener>'s face and apron, the greenhouse layout, wooden-rack position, camera direction, and greenhouse ambience continuous.
<Gardener> and <Wicker Flower Basket> each remain one continuous object without duplication or splitting. Keep body structure and basket component count stable.
```

### Backward Extension (Before the Original Video)

A backward extension generates content before the source video begins. The last frame of the new segment connects to the source video's first frame.

First describe what happens before the source video begins, then define the source video's first frame as the explicit end state of the extended segment. Writing only "then connect to the source video" may introduce later characters, props, or effects too early, or cause the image to change again after reaching the target state.

```text
@Video 1 is the source video to extend backward.

Extend @Video 1 backward. Before the source video begins, <preceding action, event, camera treatment, or audio>.

The last frame of the extended segment naturally connects to the first frame of @Video 1. Match <subject pose and orientation>, <prop position>, <background and spatial relationships>, <camera position and composition>, <lighting>, <audio state>, and <motion direction>.

Throughout the extension, maintain continuity in <character identity and clothing>, <key props>, <background layout>, <camera axis>, and <existing audio environment>.
Each subject remains the same continuous object without duplication or splitting. Keep character anatomy and object component counts stable.
Characters, props, or effects that belong only to later events in the source video must not appear early.
```

When additional references are available, define their character, clothing, prop, or audio roles one by one, then state that the source video controls the extension boundary. New materials must not override the source video's last-frame or first-frame control of the boundary image.

Extension creates only the new segment outside the boundary; it must not edit the original video at the same time. The goal is natural visual and audio continuity, not pixel-identical boundary frames. The extended segment's volume may differ slightly from the source video.

## Keyframe Anchors

Keyframe images are still uploaded as ordinary reference images; assign each one a role in the Prompt. Never combine first-frame and last-frame roles into a range sentence.

To fix a first frame, write the exact standalone sentence `@Image N is the first frame.` To fix a last frame, write the exact standalone sentence `@Image N is the last frame.` Do not weaken these into "used only as a first-frame reference," "reference the opening composition," or "first-frame composition reference," and do not compress the frame-role sentence and subsequent action into one sentence. Preserve the exact role sentence in the final Prompt, then use a new sentence to define that frame's composition, subject position, pose, prop state, scene, and camera direction.

The first frame locks the output aspect ratio. The first and last images should use the same aspect ratio to avoid stretching the last frame. Duration is still set on the generation page or through the API. This rule is for input preflight only; do not write it as an output parameter in the Prompt.

### First Frame with Additional References

```text
@Image 1 is the first frame.
This first frame defines the opening composition, subject position, pose, prop state, scene, and camera direction.
@Image 2 defines <subject>'s <appearance, clothing, structure, or material> without changing the first-frame composition defined by @Image 1.
@Image 3 defines <scene, prop, or lighting> without changing the first-frame composition defined by @Image 1.

The video begins naturally from the first frame defined by @Image 1. Then, <continuous action or event>.
Maintain continuity in <character identity, prop ownership, spatial relationships, and visual style>.
```

### First and Last Frames with Additional References

```text
@Image 1 is the first frame.
This first frame defines the opening composition, subject position, pose, prop state, scene, and camera direction.
@Image 2 is the last frame.
This last frame defines the ending composition, subject position, pose, prop state, scene, and camera direction.
@Image 3 defines <Subject A>'s <appearance, clothing, structure, or material> without changing the first-frame composition from @Image 1 or the last-frame composition from @Image 2.
@Image 4 defines <specified attributes> of <Subject B, prop, or scene> without changing the first-frame composition from @Image 1 or the last-frame composition from @Image 2.

<One continuous action or event>.
The video begins naturally from the first frame defined by @Image 1 and reaches the last frame defined by @Image 2 after the continuous action.
Between the first and last frames, maintain continuity in <character identity, prop structure and ownership, scene layout, and camera direction>.
```

Example:

```text
@Image 1 is the first frame.
This first frame defines the baking counter, <Pastry Chef>'s position, the undecorated cake, tool placement, and a frontal medium shot.
@Image 2 is the last frame.
This last frame defines the completed cake centered on the turntable, <Pastry Chef>'s hands released from the cake, and the same frontal medium shot.
@Image 3 defines <Pastry Chef>'s facial features, pinned-up hair, and white uniform without changing the first-frame composition from @Image 1 or the last-frame composition from @Image 2.
@Image 4 defines the cake's two-tier structure, white frosting material, and blueberry decoration without changing the first-frame composition from @Image 1 or the last-frame composition from @Image 2.

The video begins naturally from the first frame defined by @Image 1. <Pastry Chef> turns the cake stand, pipes an even cream border around both tiers, places the blueberries one by one, releases both hands from the cake, and naturally reaches the last frame defined by @Image 2.
Between the first and last frames, maintain continuity in <Pastry Chef>'s identity and clothing, the cake's count and two-tier structure, tool positions, baking-counter layout, and camera direction.
```

When the user explicitly requests an intermediate key state, an additional image may define the characters, action, props, and spatial relationships that must be visible near that moment. Describe the video as naturally reaching that state around the specified time. The image is a semantic anchor, not a static hold or pixel-locked frame. When the first and last boundaries are the priority, reduce other materials unrelated to the current event.

### Multi-Keyframe Sequence Control

When separate images define process stages, declare the keyframe order in the first sentence, then define every key state individually. Keyframes control stage order and visible states; they do not promise frame-by-frame reproduction or require a static hold at any key state.

```text
Use @Image 1 through @Image N in order as keyframes.

@Image 1 is the first frame.
This first frame defines <opening composition, subject position, pose, prop state, and camera direction>.
@Image 2 defines the second keyframe: <visible state at the end of the first stage>.
@Image 3 defines the third keyframe: <visible state at the end of the second stage>.
@Image N is the last frame.
This last frame defines <ending composition, subject position, pose, prop state, and camera direction>.

The video passes in order through the states defined by @Image 1, @Image 2, @Image 3, through @Image N, using continuous action to transition naturally between stages.
Throughout the sequence, maintain continuity in <subject identity, prop structure and ownership, scene layout, lighting, and camera axis>.
```

### Storyboard Grids

A storyboard grid defines the overall story, shot order, and approximate composition. It is not intended to reproduce every panel's details strictly. Prefer a clean storyboard with no more than 15 panels and minimal text labels. State the reading order, the shot structure to use, and the line-art style, annotations, or placeholder characters not to use.

```text
@Image 1 provides an <N-panel storyboard grid> for shot order and approximate composition. Read it <left to right, top to bottom>. Do not use the grid's <line-art style, text labels, or placeholder characters>.
@Image 2 defines <Subject A>'s <appearance and clothing>.
@Image 3 defines <key prop or scene>'s <structure, material, or lighting>.

Shot 1: <shot size, subject action, and scene state>.
Shot 2: <shot size, subject action, and camera movement or transition>.
...
Shot N: <closing action and final visible state>.

The final video uses <visual style>. Audio includes <dialogue, ambience, action sound effects, or music>.
```

### Blockout References and Rendering

First determine whether the blockout video provides a motion skeleton or complete structure:

- **Coarse blockout:** Simple geometry mainly provides action paths, motion direction, subject blocking, entrances and exits, camera position, camera movement, cuts, lighting changes, sound rhythm, or spatial relationships. Map every geometric object separately to its final subject or prop.
- **Fine blockout:** Character, prop, or scene structure is already complete and is mainly used to change character appearance, materials, colors, scene, or visual style. Preserve the original structure, action, space, and camera treatment.

A blockout video is a generation reference; it does not automatically become an editing master merely because it is a video. When the blockout contains path lines, coordinate axes, controllers, camera frustums, or text markers, state explicitly that those production markers must not be used.

#### Coarse Blockouts

```text
@Video 1 is a coarse blockout reference. It provides only <motion paths, subject blocking, camera position, camera movement, cuts, lighting changes, sound rhythm, or spatial relationships>. Do not use its blockout appearance, materials, or scene.
<Blockout Subject A> in @Video 1 corresponds to <Subject A>.
<Blockout Subject B or geometric prop> in @Video 1 corresponds to <Subject B or key prop>.
@Image 1 defines <Subject A>'s <appearance, clothing, or structure>.
@Image 2 defines <specified attributes> of <Subject B, key prop, or scene>.

<Subject> completes <primary action or event> in <scene>.
Keep <motion path, blocking, camera movement, cuts, lighting, or sound rhythm> from @Video 1.
The final video uses <characters, scene, materials, and visual style>. Audio includes <dialogue, ambience, or action sound effects>.
```

#### Fine Blockouts

```text
@Video 1 is a fine blockout reference. Preserve <subject structure, action, spatial layout, camera position, camera movement, and cuts>. Do not use its original gray materials, empty background, or production markers.
@Image 1 defines <subject>'s <character appearance, material, color, or surface details>.
@Image 2 defines <scene>'s <space, materials, lighting, or visual style>.

Re-render <subject> from @Video 1 as <final subject>, and re-render the scene as <final scene>.
Keep <structure, action, camera treatment, and spatial relationships> from @Video 1. Use <materials, colors, and style>. Audio includes <ambience, sound effects, or music>.
```
