import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** ffmpeg 可执行文件。装在别处时用 FFMPEG_PATH 指过去。 */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

/**
 * concat demuxer 的清单文件内容。
 * 路径用单引号包住，内部的单引号按 ffmpeg 的转义写法拆开（`'\''`）——
 * 我们的文件名是 cuid，不会有引号，但清单是拼字符串生成的，不留这个口子。
 */
export function concatListContent(absPaths: string[]): string {
  return (
    absPaths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n') +
    '\n'
  );
}

/**
 * 两套参数：先试**流拷贝**（-c copy），几乎瞬间完成且零画质损失，但要求各段的编码参数
 * 完全一致；同一个模型产出的片段通常满足。不满足时 ffmpeg 会报错，再退到**重编码**。
 * 重编码慢得多，所以不作为首选。
 */
export function concatArgs(
  listPath: string,
  outPath: string,
  mode: 'copy' | 'encode',
): string[] {
  const base = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];
  return mode === 'copy'
    ? [...base, '-c', 'copy', outPath]
    : [
        ...base,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        outPath,
      ];
}

/**
 * 把若干段视频按给定顺序拼成一个文件。
 * 先流拷贝，失败再重编码；两次都失败则把 ffmpeg 的 stderr 抛出去（写进 version.error 给用户看）。
 */
export async function concatVideos(
  absPaths: string[],
  outPath: string,
  listPath: string,
  signal?: AbortSignal,
): Promise<'copy' | 'encode'> {
  await writeFile(listPath, concatListContent(absPaths), 'utf8');
  try {
    await run(ffmpegBin(), concatArgs(listPath, outPath, 'copy'), { signal });
    return 'copy';
  } catch (copyErr) {
    if (signal?.aborted) throw copyErr;
    try {
      await run(ffmpegBin(), concatArgs(listPath, outPath, 'encode'), {
        signal,
      });
      return 'encode';
    } catch (encodeErr) {
      throw new Error(ffmpegMessage(encodeErr));
    }
  }
}

/** 从 execFile 的错误里取一段能看的信息：优先 stderr 末尾几行，其次 message。 */
export function ffmpegMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stderr' in err) {
    const { stderr } = err as { stderr?: unknown };
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim().split('\n').slice(-4).join('\n');
    }
  }
  return err instanceof Error ? err.message : String(err);
}
