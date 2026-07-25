import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI, type GenerateVideosOperation } from '@google/genai';

/** 生成结果：原始字节 + MIME 类型（落盘与 Content-Type 都需要它）。 */
export interface MediaBytes {
  bytes: Buffer;
  mimeType: string;
}

/** 参考图入参：base64 字节 + MIME（processor 从磁盘读出参考资产后传入）。 */
export interface MediaRef {
  data: string; // base64
  mimeType: string;
}

/** 视频轮询容忍的**连续**失败次数（成功一次即清零）。见 pollVideosOperation 的说明。 */
const POLL_MAX_FAILURES = 3;
/** 视频下载总尝试次数（首次 + 重试）。 */
const DOWNLOAD_ATTEMPTS = 3;

/**
 * @google/genai 的薄封装——本文件是整个项目里**唯一**触碰 @google/genai 的地方
 * （设计 §「不做」：将来换/加提供商只动这一个文件）。
 *
 * 为什么用 Injectable 而非纯函数：便于在 MediaProcessor 里经 DI 注入，单测时也可整体替换 provider；
 * 但 google client 本身不做单测（要真打云端，见设计 M2）。
 */
@Injectable()
export class GoogleMediaClient {
  private readonly logger = new Logger(GoogleMediaClient.name);
  // 懒初始化：避免模块加载期就要求 GOOGLE_API_KEY 存在（jest/CI 无 key 也能加载本类）。
  private ai?: GoogleGenAI;

  private client(): GoogleGenAI {
    if (!this.ai) {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) throw new Error('缺少 GOOGLE_API_KEY 环境变量');
      this.ai = new GoogleGenAI({ apiKey });
    }
    return this.ai;
  }

  /**
   * 文生图：经 generateContent 取第一个带 inlineData 的 part。
   * inlineData.data 是 base64 字符串（genai.d.ts:1535-1543 Blob.data @remarks base64）。
   * 若所有 part 都没有 inlineData，多半是模型拒答——把文本 part 当作拒绝原因抛出。
   */
  async generateImageBytes(
    prompt: string,
    model: string,
    refs?: MediaRef[],
  ): Promise<MediaBytes> {
    // 无参考图：保持原 contents=prompt 字符串路径（最简）；
    // 有参考图（图生图）：contents = 单条 user Content，parts = [文本, ...参考图 inlineData]
    // （genai.d.ts:2262 ContentListUnion 接受单个 Content；9211 Part.inlineData:Blob_2；1535 Blob.data 为 base64）。
    const contents =
      refs && refs.length > 0
        ? [
            {
              role: 'user',
              parts: [
                { text: prompt },
                ...refs.map((r) => ({
                  inlineData: { data: r.data, mimeType: r.mimeType },
                })),
              ],
            },
          ]
        : prompt;
    const res = await this.client().models.generateContent({
      model,
      contents,
    });
    // GenerateContentResponse.candidates[0].content.parts（genai.d.ts:4769/4774、2227-2233、9196-9211）
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        return {
          bytes: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType ?? 'image/png',
        };
      }
    }
    // 没有任何 inlineData：把文本拼起来作为失败原因（通常是安全拒答说明）
    const text = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join(' ')
      .trim();
    throw new Error(text || '生图失败：模型未返回图像数据');
  }

  /**
   * 文生视频：start 一个长任务 operation，按 10s 间隔轮询直到 done 或超时（上限 10min）。
   * SDK 轮询样例见 genai.d.ts:8626-8640（generateVideos → while(!done) getVideosOperation）。
   * 完成后取 response.generatedVideos[0].video（genai.d.ts:5139-5140、4980-4983、13427-13435）。
   * 真实 API（已实测复现）：完成的 operation 里 video 只有 `uri`（files 下载链接），
   * **没有** videoBytes —— 必须走 `ai.files.download({ file: video, downloadPath })` 落盘再读。
   * videoBytes 分支保留作快路径（SDK 类型声明它可能存在）。
   */
  async generateVideoBytes(
    prompt: string,
    model: string,
    opts?: {
      intervalMs?: number;
      timeoutMs?: number;
      firstFrame?: MediaRef;
      /** 协作取消（停止功能）：轮询每轮检查，aborted 即抛错退出 */
      signal?: AbortSignal;
    },
  ): Promise<MediaBytes> {
    const intervalMs = opts?.intervalMs ?? 10_000;
    const timeoutMs = opts?.timeoutMs ?? 600_000; // 10min
    const ai = this.client();

    // 参考图（首帧）：传 image={ imageBytes, mimeType }（genai.d.ts:5162 GenerateVideosParameters.image:Image；
    // 6393 Image.imageBytes 为 base64）。多张参考时上层只传第一张。
    const firstFrame = opts?.firstFrame;
    // generateVideos 返回 GenerateVideosOperation（genai.d.ts:8643、5130-5147）
    let op = await ai.models.generateVideos({
      model,
      prompt,
      ...(firstFrame
        ? {
            image: {
              imageBytes: firstFrame.data,
              mimeType: firstFrame.mimeType,
            },
          }
        : {}),
    });
    this.logger.log(`视频生成已提交 operation=${op.name}`);

    op = await this.pollVideosOperation(
      op,
      // getVideosOperation 接收上一份 operation，回填 done/response（genai.d.ts:8974）
      (cur) => ai.operations.getVideosOperation({ operation: cur }),
      { intervalMs, timeoutMs, signal: opts?.signal },
    );

    if (op.error) {
      throw new Error(`视频生成失败：${JSON.stringify(op.error)}`);
    }
    const video = op.response?.generatedVideos?.[0]?.video;
    if (video?.videoBytes) {
      // 快路径：极少数情况下 SDK 直接内联 base64
      return {
        bytes: Buffer.from(video.videoBytes, 'base64'),
        mimeType: video.mimeType ?? 'video/mp4',
      };
    }
    if (video?.uri) {
      // 常规路径：经 files.download 落到临时文件再读回（实测 5.3MB mp4 可用）
      const tmp = mkdtempSync(join(tmpdir(), 'veo-'));
      const downloadPath = join(tmp, 'video.mp4');
      try {
        // 下载几 MB 的 mp4 比轮询更容易撞上瞬时网络失败，失败一次不该让整条任务作废
        await this.retryTransient('视频下载', DOWNLOAD_ATTEMPTS, () =>
          ai.files.download({ file: video, downloadPath }),
        );
        return {
          bytes: readFileSync(downloadPath),
          mimeType: video.mimeType ?? 'video/mp4',
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    throw new Error(
      '视频生成失败：operation 完成但无视频数据（无 videoBytes 也无 uri）',
    );
  }

  /**
   * 轮询 videos operation 直到 done。抽成独立方法便于单测（可注入小间隔与假 poller），
   * 与 MediaProcessor.waitForRef 同一套路。
   *
   * 为什么要容错：视频链路跨度长（提交 + 每 10s 轮询 + 下载数 MB），本机直连 Google 的 TLS
   * 握手时快时慢（实测 0.6s~15s），单次轮询抛 `fetch failed` 是常态；而云端任务往往还在正常跑，
   * 一次瞬时失败就把整条 version 判死是错的。故容忍**连续** maxConsecutiveFailures 次失败，
   * 成功一次即清零；超过上限才抛最后那个错误。
   *
   * 不区分错误类型：undici 的 `fetch failed` 没有稳定错误码，真·永久错误（如模型名非法）也会被
   * 重试几轮，但有失败上限与 deadline 兜底，最坏只是晚几十秒报同一个错。
   */
  async pollVideosOperation(
    initial: GenerateVideosOperation,
    poll: (op: GenerateVideosOperation) => Promise<GenerateVideosOperation>,
    opts: {
      intervalMs: number;
      timeoutMs: number;
      maxConsecutiveFailures?: number;
      signal?: AbortSignal;
    },
  ): Promise<GenerateVideosOperation> {
    const maxFailures = opts.maxConsecutiveFailures ?? POLL_MAX_FAILURES;
    const deadline = Date.now() + opts.timeoutMs;
    let op = initial;
    let failures = 0;

    while (!op.done) {
      // 协作取消：用户停止后不再继续轮询（已提交的云端任务由 Google 侧自行完成/过期）
      if (opts.signal?.aborted) {
        throw new Error(`视频生成已取消 operation=${op.name}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `视频生成超时（>${opts.timeoutMs}ms）operation=${op.name}`,
        );
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs));
      try {
        op = await poll(op);
        failures = 0;
      } catch (e) {
        failures++;
        if (failures > maxFailures) throw e;
        this.logger.warn(
          `轮询失败（连续第 ${failures} 次，上限 ${maxFailures}）operation=${op.name}：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return op;
  }

  /** 瞬时失败重试：立即重试 attempts 次（不退避——本机的失败是握手抖动，不是限流）。 */
  private async retryTransient<T>(
    label: string,
    attempts: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= attempts) throw e;
        this.logger.warn(
          `${label}失败（第 ${i}/${attempts} 次）：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }
}
