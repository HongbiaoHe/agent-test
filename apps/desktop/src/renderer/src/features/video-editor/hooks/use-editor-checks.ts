/**
 * 剪辑器的检查数据：
 * - 规则问题：每次编辑后用字幕字体实测断行，本地实时算（lintProject）；
 * - 审片结果：读工程旁边的 <名字>.review.json，agent 审完片（文件变了）时 host 推 video-review-changed 重新读；
 * - agent 修改快照：还能撤销几轮；工程文件变了（agent 刚改过）就重查，「撤销 agent 修改」写回后同样会触发。
 */
import type { VideoProject } from '@agent-test/video-schema';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { agent } from '@/lib/agent-client';
import { reviewIssues, ruleIssues } from '../lib/issues';
import { measureEm } from '../lib/subtitle-wrap';

export function useEditorChecks(conversationId: string, path: string, project: VideoProject | null) {
  const queryClient = useQueryClient();
  const reviewKey = useMemo(() => ['video-review', conversationId, path], [conversationId, path]);
  const snapshotsKey = useMemo(() => ['video-snapshots', conversationId, path], [conversationId, path]);

  const review = useQuery({
    queryKey: reviewKey,
    queryFn: () => agent.call('video.readReview', { conversationId, path }),
  });
  const snapshots = useQuery({
    queryKey: snapshotsKey,
    queryFn: () => agent.call('video.snapshots', { conversationId, path }),
  });

  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.kind !== 'event') return;
        if (e.type !== 'video-review-changed' && e.type !== 'video-file-changed') return;
        if (e.conversationId !== conversationId || e.path !== path) return;
        void queryClient.invalidateQueries({ queryKey: e.type === 'video-review-changed' ? reviewKey : snapshotsKey });
      }),
    [conversationId, path, queryClient, reviewKey, snapshotsKey],
  );

  const rules = useMemo(() => (project ? ruleIssues(project, measureEm) : []), [project]);
  const reviewed = useMemo(
    () => (project ? reviewIssues(project, review.data ?? null) : { entries: [], stale: false }),
    [project, review.data],
  );

  /** 撤销 agent 最近一轮修改：快照写回工程文件，剪辑器随文件监听重载（进撤销栈） */
  const restoreAgentChanges = async () => {
    await agent.call('video.restoreSnapshot', { conversationId, path });
    await queryClient.invalidateQueries({ queryKey: snapshotsKey });
  };

  return {
    rules,
    review: review.data ?? null,
    reviewEntries: reviewed.entries,
    reviewStale: reviewed.stale,
    agentRounds: snapshots.data?.count ?? 0,
    restoreAgentChanges,
  };
}

export type EditorChecks = ReturnType<typeof useEditorChecks>;
