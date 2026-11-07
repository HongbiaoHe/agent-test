/**
 * 剪辑器的 host 侧服务（video.* RPC）：工程列表 / 读写（含冲突检测与文件监听）、素材探测与导入、导出任务。
 * 路径一律是会话工作区内的相对路径，解析后必须仍在工作区内。
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { type FSWatcher, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { EXPORTS_DIR, parseProject, projectDuration } from '@agent-test/video-schema';
import type {
  HostEvent,
  VideoExportStatus,
  VideoMediaProbe, VideoProjectFile, VideoProjectSummary, VideoWriteResult } from '../../shared/rpc';
import { hostI18n } from '../i18n';
import { buildAss, buildExportArgs, FfmpegError, type FfmpegRun, outputSize, runFfmpeg } from './export';
import type { FfmpegBinaries } from './ffmpeg-paths';
import { probeMedia } from './probe';
import {
  assertProjectPath,
  listProjects,
  missingSources,
  projectSources,
  readProjectFile,
  resolveExisting,
  resolveWritable,
  serializeProject,
  slugify,
  toWorkspaceRel,
  uniqueWorkspacePath,
  writeFileAtomic,
} from './project-files';

/** 文件变化防抖：编辑器 / agent 一次保存可能触发多个 fs 事件 */
const WATCH_DEBOUNCE_MS = 150;
const IMPORTS_DIR = 'media/imports';

export interface VideoServiceDeps {
  /** 会话 id → 工作区目录（会话不存在时抛错） */
  workspaceOf: (conversationId: string) => string;
  emit: (event: HostEvent) => void;
  binaries: () => FfmpegBinaries;
}

interface WatchEntry {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  /** 最近一次已知的 mtime（读 / 本服务写入时更新）：变化后与它相同就不广播，免得编辑器收到自己写入的回声 */
  knownMtimeMs: number;
}

interface ExportJob {
  run: FfmpegRun;
  outputAbs: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 导出文件名里的本地时间 YYYYMMDD-HHmmss */
export function exportStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export class VideoService {
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly jobs = new Map<string, ExportJob>();

  constructor(private readonly deps: VideoServiceDeps) {}

  list(conversationId: string): Promise<VideoProjectSummary[]> {
    return listProjects(this.deps.workspaceOf(conversationId));
  }

  async read(conversationId: string, path: string): Promise<VideoProjectFile> {
    const root = this.deps.workspaceOf(conversationId);
    const file = await readProjectFile(root, path);
    this.watchFile(conversationId, path, await resolveExisting(root, path), file.mtimeMs);
    return file;
  }

  close(conversationId: string, path: string): void {
    const key = watchKey(conversationId, path);
    const entry = this.watchers.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.watchers.delete(key);
  }

  async write(conversationId: string, path: string, project: unknown, baseMtimeMs?: number): Promise<VideoWriteResult> {
    assertProjectPath(path);
    const parsed = parseProject(project);
    if (!parsed.ok) throw new Error(hostI18n.t('errors.video.invalidProject', { issues: parsed.issues.join('; ') }));
    const abs = await resolveWritable(this.deps.workspaceOf(conversationId), path);
    const current = await stat(abs).catch(() => null);
    if (baseMtimeMs !== undefined && current && current.mtimeMs !== baseMtimeMs) {
      return { ok: false, conflict: true, mtimeMs: current.mtimeMs };
    }
    await writeFileAtomic(abs, serializeProject(parsed.project));
    const { mtimeMs } = await stat(abs);
    const entry = this.watchers.get(watchKey(conversationId, path));
    if (entry) entry.knownMtimeMs = mtimeMs;
    return { ok: true, mtimeMs };
  }

  async probe(conversationId: string, paths: string[]): Promise<VideoMediaProbe[]> {
    const root = this.deps.workspaceOf(conversationId);
    const realRoot = await resolveExisting(root, '');
    const { ffprobe } = this.deps.binaries();
    const out: VideoMediaProbe[] = [];
    for (const p of paths) {
      const abs = await resolveExisting(root, p);
      const rel = toWorkspaceRel(realRoot, abs);
      out.push({ path: rel, ...(await probeMedia(ffprobe, abs, rel)) });
    }
    return out;
  }

  /** 本机文件复制进 media/imports/（重名加 -2、-3），再探测；探测失败删掉复制品 */
  async importFiles(conversationId: string, sourcePaths: string[]): Promise<VideoMediaProbe[]> {
    const root = this.deps.workspaceOf(conversationId);
    const { ffprobe } = this.deps.binaries();
    const out: VideoMediaProbe[] = [];
    for (const source of sourcePaths) {
      const st = isAbsolute(source) ? await stat(source).catch(() => null) : null;
      if (!st?.isFile()) throw new Error(hostI18n.t('errors.video.importNotFile', { path: source }));
      const ext = extname(source).toLowerCase();
      const base = slugify(basename(source, extname(source)));
      const rel = await uniqueWorkspacePath(root, IMPORTS_DIR, base, ext);
      const dest = await resolveWritable(root, rel);
      await copyFile(source, dest);
      try {
        out.push({ path: rel, ...(await probeMedia(ffprobe, dest, rel)) });
      } catch (e) {
        await rm(dest, { force: true });
        throw e;
      }
    }
    return out;
  }

  /** 启动导出：校验 → 探测原声 → 写 ASS → 起 ffmpeg；立即返回，进度经 video-export 事件推送 */
  async startExport(
    conversationId: string,
    path: string,
    height: number | null,
    /** 字幕原文 → 剪辑器断好行的文本（见 buildAss） */
    wrappedSubtitles: Readonly<Record<string, string>> = {},
  ): Promise<{ jobId: string; outputPath: string }> {
    const root = this.deps.workspaceOf(conversationId);
    const file = await readProjectFile(root, path);
    if (!file.project) throw new Error(hostI18n.t('errors.video.invalidProject', { issues: file.issues.join('; ') }));
    const project = file.project;
    if (project.video.length === 0) throw new Error(hostI18n.t('errors.video.emptyTimeline'));
    const missing = await missingSources(root, project);
    if (missing.length) throw new Error(hostI18n.t('errors.video.missingMedia', { paths: missing.join(', ') }));

    const { ffmpeg, ffprobe } = this.deps.binaries();
    const absBySrc = new Map<string, string>();
    for (const src of projectSources(project)) absBySrc.set(src, await resolveExisting(root, src));
    const audioBySrc = new Map<string, boolean>();
    for (const clip of project.video) {
      if (clip.type !== 'video' || audioBySrc.has(clip.src)) continue;
      const abs = absBySrc.get(clip.src) ?? '';
      audioBySrc.set(clip.src, (await probeMedia(ffprobe, abs, clip.src)).hasAudio);
    }

    const tmp = await mkdtemp(join(tmpdir(), 'spark-export-'));
    let assPath: string | null = null;
    if (project.subtitles.cues.length) {
      assPath = join(tmp, 'subtitles.ass');
      await writeFile(assPath, buildAss(project, outputSize(project, height), wrappedSubtitles));
    }
    const outputPath = await uniqueWorkspacePath(root, EXPORTS_DIR, `${slugify(project.name)}-${exportStamp()}`, '.mp4');
    const outputAbs = await resolveWritable(root, outputPath);
    const args = buildExportArgs(project, {
      resolve: (src) => absBySrc.get(src) ?? src,
      hasAudio: (src) => audioBySrc.get(src) ?? false,
      outputPath: outputAbs,
      height,
      assPath,
    });

    const jobId = randomUUID();
    const emit = (
      status: VideoExportStatus,
      progress: number,
      extra: { outputPath?: string; error?: string } = {},
    ) =>
      this.deps.emit({ kind: 'event', type: 'video-export', jobId, status, progress, ...extra });
    let lastPct = -1;
    const run = runFfmpeg(ffmpeg, args, projectDuration(project), (p) => {
      const pct = Math.floor(p * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      emit('running', pct / 100);
    });
    this.jobs.set(jobId, { run, outputAbs });
    // 让调用方先拿到 jobId 再收第一条进度
    setImmediate(() => emit('running', 0));
    run.done
      .then(
        async (result) => {
          if (result === 'cancelled') {
            await rm(outputAbs, { force: true });
            emit('cancelled', 0);
          } else {
            emit('done', 1, { outputPath });
          }
        },
        async (e: unknown) => {
          await rm(outputAbs, { force: true });
          const error =
            e instanceof FfmpegError
              ? hostI18n.t('errors.video.exportFailed', { code: e.code ?? '?', detail: e.detail })
              : e instanceof Error
                ? e.message
                : String(e);
          emit('failed', 0, { error });
        },
      )
      .finally(() => {
        this.jobs.delete(jobId);
        void rm(tmp, { recursive: true, force: true });
      });
    return { jobId, outputPath };
  }

  cancelExport(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(hostI18n.t('errors.video.jobNotFound', { id: jobId }));
    job.run.cancel();
  }

  /** 停止全部监听与导出（进程退出 / 单测收尾） */
  dispose(): void {
    for (const key of [...this.watchers.keys()]) {
      const [conversationId, path] = key.split('\0');
      this.close(conversationId, path);
    }
    for (const job of this.jobs.values()) job.run.cancel();
  }

  /**
   * 监听父目录而不是文件本身：编辑器 / 不少编辑工具用「写临时文件再 rename」保存，
   * 直接 watch 文件会在 rename 后丢掉监听。
   */
  private watchFile(conversationId: string, path: string, abs: string, mtimeMs: number): void {
    const key = watchKey(conversationId, path);
    const existing = this.watchers.get(key);
    if (existing) {
      existing.knownMtimeMs = mtimeMs;
      return;
    }
    const name = basename(abs);
    const watcher = watch(dirname(abs), (_event, filename) => {
      if (filename !== null && filename !== name) return;
      const entry = this.watchers.get(key);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void stat(abs).then(
          (st) => {
            if (!this.watchers.has(key) || st.mtimeMs === entry.knownMtimeMs) return;
            entry.knownMtimeMs = st.mtimeMs;
            this.deps.emit({ kind: 'event', type: 'video-file-changed', conversationId, path, mtimeMs: st.mtimeMs });
          },
          () => undefined, // 文件被删 / 改名中途：等下一次事件
        );
      }, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', () => this.close(conversationId, path));
    this.watchers.set(key, { watcher, timer: null, knownMtimeMs: mtimeMs });
  }
}

function watchKey(conversationId: string, path: string): string {
  return `${conversationId}\0${path}`;
}
