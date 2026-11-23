import { projectFingerprint, type ReviewFile } from '@agent-test/video-schema';
import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures';
import { reviewIssues, ruleIssues, selectionOf } from './issues';

function review(fingerprint: string): ReviewFile {
  return {
    version: 1,
    reviewedAt: '2026-11-23T00:00:00.000Z',
    fingerprint,
    brief: '',
    summary: '还行',
    verdict: 'needs_work',
    strengths: [],
    issues: [
      {
        id: 'r1',
        start: 0,
        end: 1,
        severity: 'high',
        category: 'subtitle',
        problem: '字幕挡住产品',
        suggestion: '换顶部样式',
        targets: [
          { kind: 'subtitle', id: 'c1' },
          { kind: 'audio', id: 'bgm' },
        ],
      },
      { id: 'r2', start: 2, end: 3, severity: 'low', category: 'other', problem: 'x', suggestion: 'y', targets: [{ kind: 'video', id: 'gone' }] },
    ],
  };
}

describe('剪辑器问题列表', () => {
  it('规则问题：带 code 与选中目标（字幕 → cue）', () => {
    const p = sampleProject();
    p.subtitles.cues = [{ id: 'c9', start: 0, end: 0.2, text: '一二三四五六七八九十' }];
    const [entry] = ruleIssues(p);
    expect(entry.issue.code).toBe('subtitle_too_fast');
    expect(entry.target).toEqual({ kind: 'cue', id: 'c9' });
    expect(entry.tone).toBe('warning');
  });

  it('审片结果：指纹一致不过期；按严重程度上色；目标优先视频、片段已删时为 null', () => {
    const p = sampleProject();
    const fresh = reviewIssues(p, review(projectFingerprint(p)));
    expect(fresh.stale).toBe(false);
    expect(fresh.entries.map((e) => e.tone)).toEqual(['destructive', 'muted']);
    expect(fresh.entries[0].target).toEqual({ kind: 'cue', id: 'c1' });
    expect(selectionOf(p, { kind: 'subtitle', id: 'nope' })).toBeNull();
    expect(fresh.entries[1].target).toBeNull();

    const changed = { ...p, name: '改过' };
    expect(reviewIssues(changed, review(projectFingerprint(p))).stale).toBe(true);
    expect(reviewIssues(p, null)).toEqual({ entries: [], stale: false });
  });
});
