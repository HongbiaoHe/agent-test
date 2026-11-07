/**
 * 导出任务：先保存未写回的改动，再 video.export（带上与预览同一份的字幕断行），订阅 video-export 事件更新进度；可取消。
 * 状态放在编辑器这一层（不在对话框里）：关掉对话框导出照常进行，再打开还能看到进度 / 结果。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VideoProject } from '@agent-test/video-schema';
import type { HostEvent, VideoExportStatus } from '../../../../../shared/rpc';
import { wrappedSubtitles } from '../lib/subtitle-wrap';
import { agent } from '@/lib/agent-client';

export type ExportResolution = 'original' | '1080' | '720';

export type ExportState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'running'; jobId: string; progress: number }
  | { phase: 'done'; outputPath: string }
  | { phase: 'failed'; error: string }
  | { phase: 'cancelled' };

type ExportEvent = Extract<HostEvent, { type: 'video-export' }>;

const HEIGHTS: Record<ExportResolution, 720 | 1080 | null> = { original: null, '1080': 1080, '720': 720 };

export function useVideoExport({
  conversationId,
  path,
  project,
  flush,
}: {
  conversationId: string;
  path: string;
  /** 当前工程（flush 写回的就是它）；用来算字幕断行 */
  project: VideoProject | null;
  /** 导出前保存；返回 false = 有冲突 / 写失败，不导出 */
  flush: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ExportState>({ phase: 'idle' });
  const jobRef = useRef<{ jobId: string; outputPath: string } | null>(null);
  /** 拿到 jobId 之前先到的事件 */
  const early = useRef(new Map<string, ExportEvent>());

  const apply = useCallback((e: ExportEvent, fallbackOutput: string) => {
    const status: VideoExportStatus = e.status;
    if (status === 'running') setState({ phase: 'running', jobId: e.jobId, progress: e.progress });
    else if (status === 'done') setState({ phase: 'done', outputPath: e.outputPath ?? fallbackOutput });
    else if (status === 'failed') setState({ phase: 'failed', error: e.error ?? '' });
    else setState({ phase: 'cancelled' });
  }, []);

  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.kind === 'reconnected' || e.type !== 'video-export') return;
        const job = jobRef.current;
        if (job?.jobId === e.jobId) apply(e, job.outputPath);
        else if (!job) early.current.set(e.jobId, e);
      }),
    [apply],
  );

  const start = async (resolution: ExportResolution) => {
    setState({ phase: 'saving' });
    if (!(await flush())) {
      setState({ phase: 'failed', error: t('video.export.conflict') });
      return;
    }
    try {
      const job = await agent.call('video.export', {
        conversationId,
        path,
        height: HEIGHTS[resolution],
        wrappedSubtitles: project ? wrappedSubtitles(project) : undefined,
      });
      jobRef.current = job;
      setState({ phase: 'running', jobId: job.jobId, progress: 0 });
      const first = early.current.get(job.jobId);
      early.current.clear();
      if (first) apply(first, job.outputPath);
    } catch (e) {
      setState({ phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const cancel = () => {
    const job = jobRef.current;
    if (job) void agent.call('video.exportCancel', { jobId: job.jobId }).catch(() => undefined);
  };

  /** 回到选分辨率（结束后再导一次） */
  const reset = () => {
    jobRef.current = null;
    setState({ phase: 'idle' });
  };

  return { state, start, cancel, reset };
}

export type VideoExport = ReturnType<typeof useVideoExport>;
