/**
 * review_video_project：剪辑工程的整片审片（规则检查之外的第二层，由 agent 按需调用）。
 *
 * 1. 本地按工程渲染一条低清预览（480p、ultrafast，带字幕与混音）；
 * 2. 经 Web 账号上传（/media-api/uploads），再调 POST /media-api/video-reviews：后端用多模态 Flash
 *    按审片清单 + agent 给的 brief + 时间线概要看片，返回结构化意见（不扣积分，后端记用量）；
 * 3. 意见按时间区间映射回片段 / 字幕 / 音频 id，写进工程旁边的 `<名字>.review.json`（剪辑器在时间线上打标记），
 *    同时返回给 agent。
 *
 * 每轮运行最多审 MAX_REVIEWS_PER_RUN 次（工具实例每轮新建，计数跟着工具走）；只有审成功才计数。
 * 没登录 Web 账号时返回 error=not_logged_in，不计数，agent 据此提示用户登录（规则检查不受影响）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { tool } from '@langchain/core/tools';
import {
  approxMeasureEm,
  projectDuration,
  projectFingerprint,
  type ReviewFile,
  reviewOutline,
  reviewPathOf,
  reviewTargets,
  subtitleLayout,
  type VideoProject,
  VideoReviewSchema,
  wrapSubtitle,
} from '@agent-test/video-schema';
import { z } from 'zod';
import { type FileRecorder, writeTracked } from '../storage/conversation-files';
import type { WebApi } from '../web-media/web-api';
import { uploadAttachment } from '../web-media/web-media';
import { buildAss, buildExportArgs, outputSize, runFfmpeg } from './export';
import type { FfmpegBinaries } from './ffmpeg-paths';
import { probeMedia } from './probe';
import {
  missingSources,
  projectSources,
  readProjectFile,
  resolveExisting,
  resolveWritable,
  writeFileAtomic,
} from './project-files';
import { CHECK_VIDEO_PROJECT_TOOL } from './video-tools';

export const REVIEW_VIDEO_PROJECT_TOOL = 'review_video_project';
export const MAX_REVIEWS_PER_RUN = 3;
/** 预览高度：够看清构图与字幕，文件小、上传快 */
const PREVIEW_HEIGHT = 480;
/** 审片接口要等模型看完整条片：比普通请求的 30 秒放宽 */
const REVIEW_TIMEOUT_MS = 240_000;

export const VIDEO_REVIEW_PROMPT = `## 整片审片
- 一稿剪完、\`${CHECK_VIDEO_PROJECT_TOOL}\` 没有 warnings 之后，调用 \`${REVIEW_VIDEO_PROJECT_TOOL}\` 审片。brief 写清这条片子的目标、投放平台、目标时长、脚本 / 分镜要点（从对话里整理，不要问用户）。
- 审片返回的 high / medium 问题：按 suggestion 自动改 **1 轮**（改完先 \`${CHECK_VIDEO_PROJECT_TOOL}\`），再审一次；第二次审完仍没解决的问题和 low 的建议，列给用户由用户决定，不要再继续改。
- 每轮对话最多审 ${MAX_REVIEWS_PER_RUN} 次。返回 error=not_logged_in 时告诉用户：规则检查已完成，登录 Web 账号后可以整片审片——不要重试。
- 审片结果会在剪辑器时间线上标出来，用户可以点标记跳到对应时刻。`;

export interface ReviewToolOptions {
  conversationId: string;
  workspaceDir: string;
  /** 没登录 Web 账号时为 null */
  webApi: WebApi | null;
  binaries: () => FfmpegBinaries;
  /** 记下本会话新建的审片结果文件，删会话时清掉 */
  files?: FileRecorder;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

class ReviewInputError extends Error {}

/** 预览渲染：与导出同一条滤镜图，只是低清快编；字幕断行用近似字宽（Node 里没有字体可量） */
async function renderPreview(opts: ReviewToolOptions, project: VideoProject, dir: string): Promise<string> {
  const { workspaceDir } = opts;
  const { ffmpeg, ffprobe } = opts.binaries();
  const absBySrc = new Map<string, string>();
  for (const src of projectSources(project)) absBySrc.set(src, await resolveExisting(workspaceDir, src));
  const audioBySrc = new Map<string, boolean>();
  for (const clip of project.video) {
    if (clip.type !== 'video' || audioBySrc.has(clip.src)) continue;
    audioBySrc.set(clip.src, (await probeMedia(ffprobe, absBySrc.get(clip.src) ?? '', clip.src)).hasAudio);
  }
  const height = Math.min(PREVIEW_HEIGHT, project.canvas.height);
  let assPath: string | null = null;
  if (project.subtitles.cues.length) {
    const layout = subtitleLayout(project.subtitles.style, project.canvas);
    const wrapped: Record<string, string> = {};
    for (const cue of project.subtitles.cues) {
      wrapped[cue.text] ??= wrapSubtitle(cue.text, layout.maxLineWidth / layout.fontSize, approxMeasureEm).join('\n');
    }
    assPath = join(dir, 'subtitles.ass');
    await writeFile(assPath, buildAss(project, outputSize(project, height), wrapped));
  }
  const out = join(dir, 'review-preview.mp4');
  const args = buildExportArgs(project, {
    resolve: (src) => absBySrc.get(src) ?? src,
    hasAudio: (src) => audioBySrc.get(src) ?? false,
    outputPath: out,
    height,
    assPath,
    quality: 'preview',
  });
  await runFfmpeg(ffmpeg, args, projectDuration(project), () => undefined).done;
  return out;
}

export async function reviewProject(
  opts: ReviewToolOptions,
  args: { path: string; brief: string },
  reviewsLeft: number,
) {
  if (!opts.webApi) {
    return {
      error: 'not_logged_in',
      message: '整片审片需要登录 Web 账号（当前未登录）。规则检查不受影响；请告诉用户登录后可以审片，不要重试。',
    };
  }
  if (reviewsLeft <= 0) {
    return {
      error: 'limit_reached',
      message: `本轮已审片 ${MAX_REVIEWS_PER_RUN} 次，不再审：把还没解决的问题列给用户。`,
    };
  }
  const { workspaceDir } = opts;
  const rel = isAbsolute(args.path) ? relative(workspaceDir, args.path) : args.path;
  const file = await readProjectFile(workspaceDir, rel);
  if (!file.project) throw new ReviewInputError(`工程格式不对，先用 ${CHECK_VIDEO_PROJECT_TOOL} 修好：${file.issues.join('; ')}`);
  const project = file.project;
  if (project.video.length === 0) throw new ReviewInputError('视频轨是空的，没有可审的成片');
  const missing = await missingSources(workspaceDir, project);
  if (missing.length) throw new ReviewInputError(`素材缺失，先修好再审：${missing.join(', ')}`);

  const tmp = await mkdtemp(join(tmpdir(), 'spark-review-'));
  let versionId: string;
  try {
    const preview = await renderPreview(opts, project, tmp);
    const uploaded = await uploadAttachment(opts.webApi, opts.conversationId, preview, 'review-preview.mp4');
    if (!uploaded) throw new Error('预览上传失败');
    versionId = uploaded.versionId;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const review = VideoReviewSchema.parse(
    await opts.webApi.post(
      '/media-api/video-reviews',
      { versionId, brief: args.brief, outline: reviewOutline(project) },
      undefined,
      REVIEW_TIMEOUT_MS,
    ),
  );
  const total = projectDuration(project);
  const issues = review.issues.map((f, i) => {
    const start = round3(Math.min(Math.max(0, f.start), total));
    const end = round3(Math.min(Math.max(start, f.end), total));
    return { id: `r${i + 1}`, ...f, start, end, targets: reviewTargets(project, start, end) };
  });
  const saved: ReviewFile = {
    version: 1,
    reviewedAt: new Date().toISOString(),
    fingerprint: projectFingerprint(project),
    brief: args.brief,
    summary: review.summary,
    verdict: review.verdict,
    strengths: review.strengths,
    issues,
  };
  const reviewFile = reviewPathOf(rel);
  await writeTracked(opts.files, opts.conversationId, join(workspaceDir, reviewFile), async () =>
    writeFileAtomic(await resolveWritable(workspaceDir, reviewFile), `${JSON.stringify(saved, null, 2)}\n`),
  );
  return {
    verdict: review.verdict,
    summary: review.summary,
    strengths: review.strengths,
    issues,
    reviewFile,
    reviewsLeft: reviewsLeft - 1,
  };
}

const reviewSchema = z.object({
  path: z.string().min(1).describe('工程文件路径（工作区相对路径，如 videos/promo.sparkvideo.json）'),
  brief: z
    .string()
    .min(1)
    .max(4000)
    .describe('这条片子的意图：目标、投放平台、目标时长、脚本 / 分镜要点、必须出现的卖点（从对话里整理）'),
});

export function reviewVideoProjectTool(opts: ReviewToolOptions) {
  let used = 0;
  return tool(
    async (args: z.infer<typeof reviewSchema>) => {
      try {
        const res = await reviewProject(opts, args, MAX_REVIEWS_PER_RUN - used);
        if (!('error' in res)) used++;
        return JSON.stringify(res);
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: REVIEW_VIDEO_PROJECT_TOOL,
      description:
        '整片审片：本地渲染低清预览交给视觉模型看完整条片子（画面 + 声音 + 字幕），对照 brief 返回 { verdict, summary, strengths, issues }，' +
        '每条 issue 带成片时间区间、severity、category、problem、suggestion 和涉及的片段 / 字幕 / 音频 id（targets）。' +
        `要几十秒；每轮最多 ${MAX_REVIEWS_PER_RUN} 次；需要登录 Web 账号。一稿剪完、规则检查干净后调用。`,
      schema: reviewSchema,
    },
  );
}
