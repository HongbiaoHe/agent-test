/**
 * 检查面板（剪辑器右栏顶部）：规则检查的实时结果 + 最近一次审片的意见。
 * 点一条：播放头跳到问题开始处，并选中涉及的片段（检查器随之显示它的属性）。
 */
import { AlertTriangle, CircleCheck, Clapperboard, History } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EditorChecks } from '../hooks/use-editor-checks';
import { type EditorIssue, type IssueTone, ruleParams } from '../lib/issues';
import { formatTime } from '../lib/timeline';

const TONE_TEXT: Record<IssueTone, string> = {
  destructive: 'text-destructive',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
};

export function IssuesPanel({ checks, onJump }: { checks: EditorChecks; onJump: (issue: EditorIssue) => void }) {
  const { t, i18n } = useTranslation();
  const { rules, review, reviewEntries, reviewStale } = checks;
  return (
    <section className="space-y-3" data-testid="video-issues">
      <h2 className="text-xs font-semibold tracking-tight text-muted-foreground">{t('video.issues.title')}</h2>

      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
          {rules.length ? <AlertTriangle className="text-warning" /> : <CircleCheck className="text-success" />}
          {rules.length ? t('video.issues.rules', { count: rules.length }) : t('video.issues.rulesClean')}
        </p>
        {rules.map((entry) => (
          <IssueRow key={entry.key} issue={entry} onJump={onJump}>
            {t(`video.issues.rule.${entry.issue.code}`, ruleParams(entry.issue))}
          </IssueRow>
        ))}
      </div>

      {review && (
        <div className="space-y-1" data-testid="video-review">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
            <Clapperboard />
            <span>{t('video.issues.review')}</span>
            <Badge variant={review.verdict === 'pass' ? 'secondary' : 'destructive'}>
              {t(`video.issues.verdict.${review.verdict}`)}
            </Badge>
            <span className="tabular-nums">
              {t('video.issues.reviewedAt', {
                time: new Date(review.reviewedAt).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }),
              })}
            </span>
          </div>
          {reviewStale && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5" data-testid="video-review-stale">
              <History />
              {t('video.issues.stale')}
            </p>
          )}
          <p className="text-xs leading-5 text-foreground">{review.summary}</p>
          <div className={cn('space-y-1', reviewStale && 'opacity-60')}>
            {reviewEntries.map((entry) => (
              <IssueRow
                key={entry.key}
                issue={entry}
                onJump={onJump}
                badge={t(`video.issues.severity.${entry.severity}`)}
                detail={entry.suggestion}
              >
                {entry.problem}
              </IssueRow>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function IssueRow({
  issue,
  onJump,
  badge,
  detail,
  children,
}: {
  issue: EditorIssue;
  onJump: (issue: EditorIssue) => void;
  badge?: string;
  detail?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onJump(issue)}
      title={t('video.issues.jump', { time: formatTime(issue.start) })}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid="video-issue"
    >
      <span className="flex items-center gap-1.5">
        <span className={cn('font-mono tabular-nums', TONE_TEXT[issue.tone])}>{formatTime(issue.start)}</span>
        {badge && <span className={cn('font-medium', TONE_TEXT[issue.tone])}>{badge}</span>}
      </span>
      <span className="leading-5 text-foreground">{children}</span>
      {detail && <span className="leading-5 text-muted-foreground">{detail}</span>}
    </button>
  );
}
