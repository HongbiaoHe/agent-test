/**
 * 检查器：选中片段的可编辑字段（视频 / 图片 / 音频 / 字幕）+ 工程全局设置。
 * 每次改动经 lib/edit.ts 夹到 schema 允许的范围，合并键 = 对象 id + 字段（连续拖滑块只算一步撤销）。
 */
import { type AudioClip, type ImageClip, SUBTITLE_STYLES, type SubtitleCue, type VideoClip, type VideoProject } from '@agent-test/video-schema';
import { ArrowLeft, ArrowRight, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  clampImageDuration,
  clampVolume,
  MAX_IMAGE_DURATION,
  MAX_VOLUME,
  MIN_SPAN,
  moveTrackClip,
  removeSelection,
  retimeCue,
  type Selection,
  trimAudioClip,
  trimVideoClip,
  updateAudioClip,
  updateCue,
  updateTrackClip,
} from '../lib/edit';
import { formatTime } from '../lib/timeline';
import { Field, NumberField, TextField } from './fields';

type Edit = (project: VideoProject, key?: string) => void;

const isSubtitleStyle = (v: unknown): v is VideoProject['subtitles']['style'] => SUBTITLE_STYLES.some((s) => s === v);

export function Inspector({
  project,
  duration,
  selection,
  onSelect,
  edit,
}: {
  project: VideoProject;
  duration: number;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  edit: Edit;
}) {
  const { t } = useTranslation();
  const remove = () => {
    edit(removeSelection(project, selection));
    onSelect(null);
  };

  let body: ReactNode = <p className="text-sm text-muted-foreground">{t('video.inspector.noSelection')}</p>;
  if (selection?.kind === 'video') {
    const clip = project.video.find((c) => c.id === selection.id);
    const index = project.video.findIndex((c) => c.id === selection.id);
    if (clip) {
      body = (
        <>
          {clip.type === 'video' ? (
            <VideoClipFields clip={clip} project={project} edit={edit} />
          ) : (
            <ImageClipFields clip={clip} project={project} edit={edit} />
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" disabled={index <= 0} onClick={() => edit(moveTrackClip(project, clip.id, -1))}>
              <ArrowLeft />
              {t('video.inspector.moveLeft')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={index >= project.video.length - 1}
              onClick={() => edit(moveTrackClip(project, clip.id, 1))}
            >
              <ArrowRight />
              {t('video.inspector.moveRight')}
            </Button>
            <RemoveButton onClick={remove} />
          </div>
        </>
      );
    }
  } else if (selection?.kind === 'audio') {
    const clip = project.audio.find((c) => c.id === selection.id);
    if (clip) {
      body = (
        <>
          <AudioClipFields clip={clip} project={project} edit={edit} />
          <RemoveButton onClick={remove} />
        </>
      );
    }
  } else if (selection?.kind === 'cue') {
    const cue = project.subtitles.cues.find((c) => c.id === selection.id);
    if (cue) {
      body = (
        <>
          <CueFields cue={cue} project={project} edit={edit} />
          <RemoveButton onClick={remove} />
        </>
      );
    }
  }

  return (
    <div className="space-y-5 p-4" data-testid="video-inspector">
      <section className="space-y-3">{body}</section>
      <Separator />
      <ProjectFields project={project} duration={duration} edit={edit} />
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="destructive" size="sm" onClick={onClick}>
      <Trash2 />
      {t('video.inspector.remove')}
    </Button>
  );
}

function SectionTitle({ title, src }: { title: string; src?: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {src && (
        <p className="truncate font-mono text-xs text-muted-foreground" title={src}>
          {src}
        </p>
      )}
    </div>
  );
}

function VideoClipFields({ clip, project, edit }: { clip: VideoClip; project: VideoProject; edit: Edit }) {
  const { t } = useTranslation();
  const set = (field: string, fn: (c: VideoClip) => VideoClip) =>
    edit(updateTrackClip(project, clip.id, (c) => (c.type === 'video' ? fn(c) : c)), `${clip.id}:${field}`);
  return (
    <>
      <SectionTitle title={t('video.inspector.videoClip')} src={clip.src} />
      <NumberField
        label={t('video.inspector.inPoint')}
        value={clip.inPoint}
        min={0}
        max={clip.sourceDuration - MIN_SPAN}
        slider
        hint={t('video.inspector.sourceDuration', { duration: formatTime(clip.sourceDuration) })}
        onChange={(v) => set('in', (c) => trimVideoClip(c, { inPoint: v }))}
      />
      <NumberField
        label={t('video.inspector.outPoint')}
        value={clip.outPoint}
        min={MIN_SPAN}
        max={clip.sourceDuration}
        slider
        onChange={(v) => set('out', (c) => trimVideoClip(c, { outPoint: v }))}
      />
      <NumberField
        label={t('video.inspector.volume')}
        value={clip.volume}
        min={0}
        max={MAX_VOLUME}
        step={0.05}
        slider
        onChange={(v) => set('volume', (c) => ({ ...c, volume: clampVolume(v) }))}
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        {t('video.inspector.mute')}
        <Switch
          checked={clip.volume === 0}
          onCheckedChange={(muted) => set('mute', (c) => ({ ...c, volume: muted ? 0 : 1 }))}
        />
      </label>
    </>
  );
}

function ImageClipFields({ clip, project, edit }: { clip: ImageClip; project: VideoProject; edit: Edit }) {
  const { t } = useTranslation();
  return (
    <>
      <SectionTitle title={t('video.inspector.imageClip')} src={clip.src} />
      <NumberField
        label={t('video.inspector.clipDuration')}
        value={clip.duration}
        min={MIN_SPAN}
        max={MAX_IMAGE_DURATION}
        onChange={(v) =>
          edit(
            updateTrackClip(project, clip.id, (c) => (c.type === 'image' ? { ...c, duration: clampImageDuration(v) } : c)),
            `${clip.id}:duration`,
          )
        }
      />
    </>
  );
}

function AudioClipFields({ clip, project, edit }: { clip: AudioClip; project: VideoProject; edit: Edit }) {
  const { t } = useTranslation();
  const set = (field: string, fn: (c: AudioClip) => AudioClip) => edit(updateAudioClip(project, clip.id, fn), `${clip.id}:${field}`);
  const length = clip.outPoint - clip.inPoint;
  return (
    <>
      <SectionTitle title={t('video.inspector.audioClip')} src={clip.src} />
      <NumberField
        label={t('video.inspector.start')}
        value={clip.start}
        min={0}
        max={Math.max(3600, clip.start)}
        onChange={(v) => set('start', (c) => ({ ...c, start: Math.max(0, Math.round(v * 1000) / 1000) }))}
      />
      <NumberField
        label={t('video.inspector.inPoint')}
        value={clip.inPoint}
        min={0}
        max={clip.sourceDuration - MIN_SPAN}
        slider
        hint={t('video.inspector.sourceDuration', { duration: formatTime(clip.sourceDuration) })}
        onChange={(v) => set('in', (c) => trimAudioClip(c, { inPoint: v }))}
      />
      <NumberField
        label={t('video.inspector.outPoint')}
        value={clip.outPoint}
        min={MIN_SPAN}
        max={clip.sourceDuration}
        slider
        onChange={(v) => set('out', (c) => trimAudioClip(c, { outPoint: v }))}
      />
      <NumberField
        label={t('video.inspector.volume')}
        value={clip.volume}
        min={0}
        max={MAX_VOLUME}
        step={0.05}
        slider
        onChange={(v) => set('volume', (c) => ({ ...c, volume: clampVolume(v) }))}
      />
      <NumberField
        label={t('video.inspector.fadeIn')}
        value={clip.fadeIn}
        min={0}
        max={length}
        onChange={(v) => set('fadeIn', (c) => trimAudioClip(c, { fadeIn: v }))}
      />
      <NumberField
        label={t('video.inspector.fadeOut')}
        value={clip.fadeOut}
        min={0}
        max={length}
        onChange={(v) => set('fadeOut', (c) => trimAudioClip(c, { fadeOut: v }))}
      />
    </>
  );
}

function CueFields({ cue, project, edit }: { cue: SubtitleCue; project: VideoProject; edit: Edit }) {
  const { t } = useTranslation();
  const set = (field: string, fn: (c: SubtitleCue) => SubtitleCue) => edit(updateCue(project, cue.id, fn), `${cue.id}:${field}`);
  return (
    <>
      <SectionTitle title={t('video.inspector.cue')} />
      <NumberField
        label={t('video.inspector.cueStart')}
        value={cue.start}
        min={0}
        max={Math.max(3600, cue.end)}
        onChange={(v) => set('start', (c) => retimeCue(c, { start: v }))}
      />
      <NumberField
        label={t('video.inspector.cueEnd')}
        value={cue.end}
        min={MIN_SPAN}
        max={Math.max(3600, cue.end)}
        onChange={(v) => set('end', (c) => retimeCue(c, { end: v }))}
      />
      <TextField
        label={t('video.inspector.cueText')}
        value={cue.text}
        multiline
        onChange={(v) => set('text', (c) => ({ ...c, text: v.slice(0, 500) }))}
      />
    </>
  );
}

function ProjectFields({ project, duration, edit }: { project: VideoProject; duration: number; edit: Edit }) {
  const { t } = useTranslation();
  const styleItems = Object.fromEntries(SUBTITLE_STYLES.map((s) => [s, t(`video.inspector.styles.${s}`)]));
  return (
    <section className="space-y-3">
      <SectionTitle title={t('video.inspector.project')} />
      <TextField
        label={t('video.inspector.name')}
        value={project.name}
        onChange={(v) => edit({ ...project, name: v.slice(0, 200) }, 'project:name')}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('video.inspector.canvas')}</dt>
        <dd className="font-mono text-xs leading-5 tabular-nums">
          {t('video.inspector.canvasValue', {
            width: project.canvas.width,
            height: project.canvas.height,
            fps: project.canvas.fps,
          })}
        </dd>
        <dt className="text-muted-foreground">{t('video.inspector.duration')}</dt>
        <dd className="font-mono text-xs leading-5 tabular-nums">{formatTime(duration)}</dd>
      </dl>
      <Field label={t('video.inspector.subtitleStyle')}>
        <Select
          items={styleItems}
          value={project.subtitles.style}
          onValueChange={(v) => {
            if (isSubtitleStyle(v)) edit({ ...project, subtitles: { ...project.subtitles, style: v } });
          }}
        >
          <SelectTrigger className="w-full" aria-label={t('video.inspector.subtitleStyle')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUBTITLE_STYLES.map((s) => (
              <SelectItem key={s} value={s}>
                {styleItems[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </section>
  );
}
