/**
 * 剪辑器里显示的问题（纯函数，单测见 issues.test.ts）：规则检查（lintProject，每次编辑实时算）+ 审片结果
 * （工程旁边的 <名字>.review.json，工程改过后标为过期）。两类合成一张表，时间线打标记、检查面板列出来，
 * 点一下跳到对应时刻并选中涉及的片段。
 */
import {
  type LintIssue,
  lintProject,
  projectFingerprint,
  type ReviewFile,
  type ReviewSeverity,
  type ReviewTarget,
  type VideoProject,
} from '@agent-test/video-schema';
import type { Selection } from './edit';

export type IssueTone = 'destructive' | 'warning' | 'muted';

export interface RuleEntry {
  source: 'rule';
  key: string;
  issue: LintIssue;
  start: number;
  end: number;
  target: Selection;
  tone: IssueTone;
}

export interface ReviewEntry {
  source: 'review';
  key: string;
  severity: ReviewSeverity;
  problem: string;
  suggestion: string;
  start: number;
  end: number;
  target: Selection;
  tone: IssueTone;
}

export type EditorIssue = RuleEntry | ReviewEntry;

/** 审片 / 规则的 target（subtitle）→ 剪辑器的选中（cue）；指向的片段已经不在工程里时为 null */
export function selectionOf(project: VideoProject, target: ReviewTarget | null | undefined): Selection {
  if (!target) return null;
  if (target.kind === 'video') return project.video.some((c) => c.id === target.id) ? { kind: 'video', id: target.id } : null;
  if (target.kind === 'audio') return project.audio.some((c) => c.id === target.id) ? { kind: 'audio', id: target.id } : null;
  return project.subtitles.cues.some((c) => c.id === target.id) ? { kind: 'cue', id: target.id } : null;
}

/** 规则问题的文案参数：比例类（黑边、分辨率）按百分比显示 */
export function ruleParams(issue: LintIssue): { value: number; limit: number } {
  if (issue.code === 'letterbox' || issue.code === 'low_resolution') {
    return { value: Math.round(issue.value * 100), limit: Math.round(issue.limit * 100) };
  }
  return { value: issue.value, limit: issue.limit };
}

const SEVERITY_TONE: Record<ReviewSeverity, IssueTone> = { high: 'destructive', medium: 'warning', low: 'muted' };

export function ruleIssues(project: VideoProject, measureEm?: (text: string) => number): RuleEntry[] {
  return lintProject(project, { measureEm }).map((issue, i) => ({
    source: 'rule',
    key: `rule:${issue.code}:${issue.target.id}:${i}`,
    issue,
    start: issue.start,
    end: issue.end,
    target: selectionOf(project, issue.target),
    tone: 'warning',
  }));
}

export function reviewIssues(project: VideoProject, review: ReviewFile | null): { entries: ReviewEntry[]; stale: boolean } {
  if (!review) return { entries: [], stale: false };
  const stale = review.fingerprint !== projectFingerprint(project);
  const entries = review.issues.map((f): ReviewEntry => ({
    source: 'review',
    key: `review:${f.id}`,
    severity: f.severity,
    problem: f.problem,
    suggestion: f.suggestion,
    start: f.start,
    end: f.end,
    // 优先选中视频片段（最常要改的），其次字幕、音频
    target:
      selectionOf(project, f.targets.find((t) => t.kind === 'video')) ??
      selectionOf(project, f.targets.find((t) => t.kind === 'subtitle')) ??
      selectionOf(project, f.targets.find((t) => t.kind === 'audio')),
    tone: SEVERITY_TONE[f.severity],
  }));
  return { entries, stale };
}
