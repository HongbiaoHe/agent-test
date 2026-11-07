/**
 * 剪辑工程的两个 agent 工具（只在 desktop 注册）：
 * - create_video_project：把生成产物（versionId，先下载进 media/<versionId>/）或工作区文件拼成
 *   `videos/<slug>.sparkvideo.json`，ffprobe 补全时长与宽高；
 * - check_video_project：只读校验一个工程（schema、缺失素材、总时长），agent 用文件工具改完工程后自查。
 *
 * 结果形状 `{ path, name, duration, videoClips, audioClips, subtitles, warnings }` 由 renderer 的
 * features/video-editor/lib/tool-result.ts 解析成「打开剪辑器」卡片，字段名不能改。
 * 失败一律返回 `{ error, ... }` 给模型改正，不抛（同 preview_page）。
 */
import { isAbsolute, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { tool } from '@langchain/core/tools';
import {
  type AudioClip,
  type Canvas,
  parseProject,
  PROJECT_FILE_SUFFIX,
  PROJECTS_DIR,
  projectDuration,
  SUBTITLE_STYLES,
  type SubtitleCue,
  type TrackClip,
  VIDEO_PROJECT_VERSION,
  type VideoProject,
} from '@agent-test/video-schema';
import { z } from 'zod';
import type { WebApi } from '../web-media/web-api';
import { syncMediaToWorkspace } from '../web-media/web-media';
import { type MediaInfo, probeMedia } from './probe';
import {
  missingSources,
  readProjectFile,
  resolveExisting,
  resolveWritable,
  serializeProject,
  slugify,
  toWorkspaceRel,
  uniqueWorkspacePath,
  writeFileAtomic,
} from './project-files';

export const CREATE_VIDEO_PROJECT_TOOL = 'create_video_project';
export const CHECK_VIDEO_PROJECT_TOOL = 'check_video_project';

const DEFAULT_IMAGE_SECONDS = 3;

/** 给模型看的工程格式说明（勾选任一剪辑工具时拼进系统提示） */
export const VIDEO_PROJECT_PROMPT = `## 视频剪辑工程
- 用 \`${CREATE_VIDEO_PROJECT_TOOL}\` 把生成的视频 / 图片 / 音频（versionId）或工作区文件（path）拼成剪辑工程，写在 \`${PROJECTS_DIR}/<名字>${PROJECT_FILE_SUFFIX}\`；用户在对话卡片上点「打开剪辑器」即可预览、调整与导出。
- 工程是 JSON，固定三轨：
  - \`video\`：视频轨，按数组顺序首尾相接。视频片段 \`{ id, type:"video", src, sourceDuration, inPoint, outPoint, volume, width, height }\`（截取 [inPoint, outPoint) 秒，volume 是原声音量 0～2）；图片片段 \`{ id, type:"image", src, duration, width, height }\`。
  - \`audio\`：背景音乐 / 配音，可多段、可重叠：\`{ id, src, sourceDuration, start, inPoint, outPoint, volume, fadeIn, fadeOut }\`，start 是在成片里的起点（秒）。
  - \`subtitles\`：\`{ style, cues: [{ id, start, end, text }] }\`，style 取 ${SUBTITLE_STYLES.map((s) => `\`${s}\``).join(' / ')}。
  - \`canvas\`：\`{ width, height, fps }\`；尺寸不同的片段等比缩放后补黑边。成片时长 = 视频轨总长，超出的音频与字幕导出时截掉。
- src 一律是工作区相对路径。小改动（调出入点、改字幕、换顺序、调音量）可以直接用文件工具改 JSON；id 全局唯一，出点不能超过 sourceDuration。改完必须调用 \`${CHECK_VIDEO_PROJECT_TOOL}\` 自查。
- 你没有导出工具：需要成片时，提醒用户在剪辑器里点「导出」（产物在 exports/ 目录）。`;

const refFields = {
  versionId: z.string().min(1).optional().describe('生成产物或用户附件的 versionId（与 path 二选一）'),
  path: z.string().min(1).optional().describe('工作区里的素材文件路径，相对路径或工作区内的绝对路径（与 versionId 二选一）'),
};

// 注意：Gemini 的工具 schema 不认 exclusiveMinimum，数值下限一律用 .min(0) 而不是 .positive()
const createSchema = z.object({
  name: z.string().trim().min(1).max(200).describe('工程名（也用作文件名）'),
  clips: z
    .array(
      z.object({
        ...refFields,
        inPoint: z.number().min(0).optional().describe('视频片段：入点（秒），默认 0'),
        outPoint: z.number().min(0).optional().describe('视频片段：出点（秒），默认素材结尾'),
        duration: z.number().min(0).max(600).optional().describe(`图片片段：显示秒数，默认 ${DEFAULT_IMAGE_SECONDS}`),
        volume: z.number().min(0).max(2).optional().describe('视频片段原声音量 0～2，默认 1；0 = 静音'),
      }),
    )
    .min(1)
    .max(100)
    .describe('视频轨：按顺序首尾相接的视频 / 图片片段'),
  audio: z
    .array(
      z.object({
        ...refFields,
        start: z.number().min(0).describe('在成片里的起点（秒）'),
        inPoint: z.number().min(0).optional().describe('截取起点（秒），默认 0'),
        outPoint: z.number().min(0).optional().describe('截取终点（秒），默认素材结尾'),
        volume: z.number().min(0).max(2).optional().describe('音量 0～2，默认 1'),
        fadeIn: z.number().min(0).optional().describe('淡入秒数，默认 0'),
        fadeOut: z.number().min(0).optional().describe('淡出秒数，默认 0'),
      }),
    )
    .max(50)
    .optional()
    .describe('音频轨：背景音乐 / 配音，可多段、可重叠，导出时与视频原声混音'),
  subtitles: z
    .array(
      z.object({
        start: z.number().min(0).describe('开始时间（秒，成片时间轴）'),
        end: z.number().min(0).describe('结束时间（秒），须晚于 start'),
        text: z.string().min(1).max(500).describe('字幕文本'),
      }),
    )
    .max(2000)
    .optional()
    .describe('字幕'),
  subtitleStyle: z
    .enum(SUBTITLE_STYLES)
    .optional()
    .describe('字幕样式：bottom-outline 底部白字黑描边（默认）、bottom-box 底部白字半透明底、top 顶部'),
  canvas: z
    .object({
      width: z.number().int().min(16).max(8192).describe('宽（像素）'),
      height: z.number().int().min(16).max(8192).describe('高（像素）'),
    })
    .optional()
    .describe('画布尺寸，默认取第一段素材的尺寸'),
});

type CreateArgs = z.infer<typeof createSchema>;
export type CreateVideoProjectArgs = z.input<typeof createSchema>;
type Ref = { versionId?: string; path?: string };

export interface VideoToolOptions {
  conversationId: string;
  workspaceDir: string;
  /** 没登录 Web 账号时为 null：带 versionId 的素材报错 */
  webApi: WebApi | null;
  ffprobe: () => string;
}

class ToolInputError extends Error {
  constructor(
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** versionId 先下载进 media/<versionId>/，返回 versionId → 工作区相对路径 */
async function syncVersions(opts: VideoToolOptions, versionIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!versionIds.length) return out;
  if (!opts.webApi) {
    throw new ToolInputError(
      '引用 versionId 需要先登录 Web 账号（当前未登录）。请提示用户在设置里登录，或改用工作区里的文件（path）。',
    );
  }
  const res = await syncMediaToWorkspace(opts.webApi, opts.conversationId, opts.workspaceDir, versionIds);
  if ('error' in res) throw new ToolInputError('下载素材失败', { detail: res.error });
  for (const s of res.synced) out.set(s.versionId, relative(opts.workspaceDir, s.path).split(sep).join('/'));
  if (res.errors?.length) throw new ToolInputError('部分素材下载失败', { errors: res.errors });
  return out;
}

/** 解析所有素材引用 → 规范化的工作区相对路径 + ffprobe 信息 */
async function resolveRefs(opts: VideoToolOptions, args: CreateArgs) {
  const refs: Ref[] = [...args.clips, ...(args.audio ?? [])];
  for (const r of refs) {
    if (!r.versionId === !r.path) throw new ToolInputError('每段素材必须且只能给 versionId 或 path 之一');
  }
  const versions = await syncVersions(opts, [...new Set(refs.flatMap((r) => (r.versionId ? [r.versionId] : [])))]);
  const realRoot = await realpath(opts.workspaceDir);
  const probes = new Map<string, MediaInfo>();

  return async (r: Ref): Promise<{ src: string; info: MediaInfo }> => {
    let given = r.versionId ? (versions.get(r.versionId) ?? '') : (r.path ?? '');
    if (isAbsolute(given)) given = relative(opts.workspaceDir, given);
    let abs: string;
    try {
      abs = await resolveExisting(opts.workspaceDir, given);
    } catch {
      throw new ToolInputError(`素材不存在或不在工作区内：${r.path ?? r.versionId ?? ''}`);
    }
    const src = toWorkspaceRel(realRoot, abs);
    let info = probes.get(src);
    if (!info) {
      try {
        info = await probeMedia(opts.ffprobe(), abs, src);
      } catch (e) {
        throw new ToolInputError(e instanceof Error ? e.message : String(e));
      }
      probes.set(src, info);
    }
    return { src, info };
  };
}

async function createProject(opts: VideoToolOptions, args: CreateArgs) {
  const warnings: string[] = [];
  const resolveRef = await resolveRefs(opts, args);

  const video: TrackClip[] = [];
  for (const [i, c] of args.clips.entries()) {
    const { src, info } = await resolveRef(c);
    const id = `v${i + 1}`;
    const width = info.width ?? 0;
    const height = info.height ?? 0;
    const versionId = c.versionId ? { versionId: c.versionId } : {};
    if (info.kind === 'image') {
      video.push({ id, type: 'image', src, duration: c.duration || DEFAULT_IMAGE_SECONDS, width, height, ...versionId });
      continue;
    }
    if (info.kind !== 'video' || info.duration === null) {
      throw new ToolInputError(`clips[${i}]（${src}）不是视频或图片；纯音频请放进 audio`);
    }
    const sourceDuration = info.duration;
    let outPoint = c.outPoint ?? sourceDuration;
    if (outPoint > sourceDuration) {
      warnings.push(`clips[${i}] 的出点 ${outPoint}s 超过素材时长，已截到 ${round3(sourceDuration)}s`);
      outPoint = sourceDuration;
    }
    const inPoint = c.inPoint ?? 0;
    if (inPoint >= outPoint) throw new ToolInputError(`clips[${i}] 的入点必须小于出点（素材时长 ${round3(sourceDuration)}s）`);
    video.push({ id, type: 'video', src, sourceDuration, inPoint, outPoint, volume: c.volume ?? 1, width, height, ...versionId });
  }
  const total = projectDuration({ video });

  const audio: AudioClip[] = [];
  for (const [i, a] of (args.audio ?? []).entries()) {
    const { src, info } = await resolveRef(a);
    if (!info.hasAudio || info.duration === null) throw new ToolInputError(`audio[${i}]（${src}）没有音轨`);
    const sourceDuration = info.duration;
    let outPoint = a.outPoint ?? sourceDuration;
    if (outPoint > sourceDuration) {
      warnings.push(`audio[${i}] 的出点 ${outPoint}s 超过素材时长，已截到 ${round3(sourceDuration)}s`);
      outPoint = sourceDuration;
    }
    const inPoint = a.inPoint ?? 0;
    if (inPoint >= outPoint) throw new ToolInputError(`audio[${i}] 的入点必须小于出点（素材时长 ${round3(sourceDuration)}s）`);
    let fadeIn = a.fadeIn ?? 0;
    let fadeOut = a.fadeOut ?? 0;
    const len = outPoint - inPoint;
    if (fadeIn + fadeOut > len) {
      const k = len / (fadeIn + fadeOut);
      fadeIn = round3(fadeIn * k * 0.999);
      fadeOut = round3(fadeOut * k * 0.999);
      warnings.push(`audio[${i}] 的淡入淡出总长超过这段音频，已按比例缩短`);
    }
    if (a.start >= total) warnings.push(`audio[${i}] 的起点 ${a.start}s 在成片（${round3(total)}s）之后，导出时听不到`);
    const versionId = a.versionId ? { versionId: a.versionId } : {};
    audio.push({ id: `a${i + 1}`, src, sourceDuration, start: a.start, inPoint, outPoint, volume: a.volume ?? 1, fadeIn, fadeOut, ...versionId });
  }

  const cues: SubtitleCue[] = [];
  for (const [i, s] of (args.subtitles ?? []).entries()) {
    if (s.end <= s.start) throw new ToolInputError(`subtitles[${i}] 的 end 必须晚于 start`);
    if (s.end > total + 1e-6) warnings.push(`subtitles[${i}] 超出成片时长（${round3(total)}s），超出部分导出时截掉`);
    cues.push({ id: `s${i + 1}`, start: s.start, end: s.end, text: s.text });
  }

  const first = video[0];
  const canvas: Canvas = { width: args.canvas?.width ?? first.width, height: args.canvas?.height ?? first.height, fps: 30 };
  const draft: VideoProject = {
    version: VIDEO_PROJECT_VERSION,
    name: args.name,
    canvas,
    video,
    audio,
    subtitles: { style: args.subtitleStyle ?? 'bottom-outline', cues },
  };
  const parsed = parseProject(draft);
  if (!parsed.ok) throw new ToolInputError('工程校验不通过', { issues: parsed.issues });

  const rel = await uniqueWorkspacePath(opts.workspaceDir, PROJECTS_DIR, slugify(args.name), PROJECT_FILE_SUFFIX);
  await writeFileAtomic(await resolveWritable(opts.workspaceDir, rel), serializeProject(parsed.project));
  return {
    path: rel,
    name: parsed.project.name,
    duration: round3(total),
    videoClips: video.length,
    audioClips: audio.length,
    subtitles: cues.length,
    warnings,
  };
}

export function createVideoProjectTool(opts: VideoToolOptions) {
  return tool(
    async (args: CreateArgs) => {
      try {
        return JSON.stringify(await createProject(opts, args));
      } catch (e) {
        if (e instanceof ToolInputError) return JSON.stringify({ error: e.message, ...e.extra });
        throw e;
      }
    },
    {
      name: CREATE_VIDEO_PROJECT_TOOL,
      description:
        '把视频 / 图片 / 音频素材拼成一个可编辑的剪辑工程（视频轨 + 音频轨 + 字幕），写进工作区 videos/ 目录，' +
        '用户可在剪辑器里预览、微调并导出 mp4。素材可以是本会话生成的产物（versionId，会先下载进 media/）或工作区文件（path）。' +
        '时长与尺寸会自动读取，不必提供。用户想把多段生成结果剪成一条片子、加背景音乐或字幕时使用。',
      schema: createSchema,
    },
  );
}

/** 只读校验：结构 + 缺失素材 + 总时长 */
export async function checkProject(workspaceDir: string, path: string) {
  const rel = isAbsolute(path) ? relative(workspaceDir, path) : path;
  const file = await readProjectFile(workspaceDir, rel);
  if (!file.project) return { ok: false, issues: file.issues, missing: [], duration: null };
  const missing = await missingSources(workspaceDir, file.project);
  return {
    ok: missing.length === 0,
    issues: [],
    missing,
    duration: round3(projectDuration(file.project)),
  };
}

export function checkVideoProjectTool(opts: Pick<VideoToolOptions, 'workspaceDir'>) {
  return tool(
    async ({ path }: { path: string }) => {
      try {
        return JSON.stringify(await checkProject(opts.workspaceDir, path));
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: CHECK_VIDEO_PROJECT_TOOL,
      description:
        `校验一个剪辑工程（${PROJECT_FILE_SUFFIX}）：返回 { ok, issues, missing, duration }——issues 是格式问题，` +
        'missing 是工作区里找不到的素材路径，duration 是成片总时长（秒）。用文件工具改完工程后必须调用一次自查。',
      schema: z.object({ path: z.string().min(1).describe(`工程文件路径（工作区相对路径，如 videos/promo${PROJECT_FILE_SUFFIX}）`) }),
    },
  );
}
