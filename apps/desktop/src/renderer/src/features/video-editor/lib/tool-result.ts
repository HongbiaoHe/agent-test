/**
 * create_video_project 的工具结果（LangChain 把返回值序列化成 JSON 字符串）→ 对话里的工程卡片。
 * 形状 `{ path, name, duration, videoClips, audioClips, subtitles, warnings }`；各轨数量兼容数字或数组。
 * 失败结果（没有 path 的报错文本 / JSON）返回 null，不出卡片。
 */
import { PROJECT_FILE_SUFFIX } from '@agent-test/video-schema';
import { z } from 'zod';

const count = z.union([z.number().int().nonnegative(), z.array(z.unknown()).transform((a) => a.length)]);

const resultSchema = z.object({
  path: z.string().min(1).refine((p) => p.endsWith(PROJECT_FILE_SUFFIX)),
  name: z.string().min(1),
  duration: z.number().nonnegative(),
  videoClips: count,
  audioClips: count,
  subtitles: count,
  warnings: z.array(z.string()).catch([]),
});

export type VideoProjectCardInfo = z.output<typeof resultSchema>;

export const VIDEO_PROJECT_TOOL = 'create_video_project';

export function parseVideoProjectResult(content: unknown): VideoProjectCardInfo | null {
  let raw: unknown = content;
  if (typeof content === 'string') {
    try {
      raw = JSON.parse(content);
    } catch {
      return null;
    }
  }
  const parsed = resultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 工作区面板等入口：是不是剪辑工程文件 */
export function isVideoProjectPath(path: string): boolean {
  return path.endsWith(PROJECT_FILE_SUFFIX);
}
