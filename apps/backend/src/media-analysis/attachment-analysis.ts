/**
 * 附件理解注入给 agent 的文本（纯函数，无 IO，便于单测）。
 *
 * 一轮消息带附件时，worker 在模型第一次调用前追加一条「## 附件理解」消息（落库、随历史重放，
 * 位置固定不伤缓存，同 canvas-skills 的清单注入）。按 versionId 一一对应，只放摘要和要点，
 * 完整结构化细节由 get_media_analysis(versionId) 按需取。
 */

/** 注入行在 CanvasMessage 里的 type（role=user；loadHistory 重放它，前端对话流不展示） */
export const ATTACHMENT_ANALYSIS_TYPE = 'attachment_analysis';

/** 附件理解的进度事件（推给前端思考行显示「Reading attachments 2/3」，不落库） */
export interface AttachmentAnalysisEvent {
  status: 'reading' | 'finished';
  done: number;
  total: number;
}

export interface AttachmentRef {
  versionId: string;
  type: string;
  filename: string;
}

export interface AnalysisRow {
  versionId: string;
  status: string;
  summary: string | null;
  detail: unknown;
  error: string | null;
}

/** 终态：分析不会再变（done / failed / skipped） */
export function isSettled(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped';
}

/** 取一个文本字段：压成单行（画面文字常带换行，会把要点行拆断），空值与「无」视为没有 */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t !== '无' ? t : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 要点行：按类型挑最影响创作决策的几项，单行不超过约 160 字 */
function keyPoints(type: string, detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = new Map<string, unknown>(Object.entries(detail));
  const pick = (key: string, label: string) => {
    const v = str(d.get(key));
    return v ? `${label}${clip(v, 50)}` : null;
  };
  let parts: (string | null)[] = [];
  if (type === 'image') {
    parts = [
      pick('subject', '主体：'),
      pick('composition', '构图：'),
      pick('style', '风格：'),
      pick('orientation', '画幅：'),
      pick('text_in_image', '画面文字：'),
    ];
  } else if (type === 'video') {
    const shots = d.get('shots');
    const duration = d.get('duration_seconds');
    parts = [
      typeof duration === 'number'
        ? `时长：约 ${Math.round(duration)} 秒`
        : null,
      Array.isArray(shots) ? `分镜：${shots.length} 个` : null,
      pick('style', '风格：'),
      pick('orientation', '画幅：'),
      pick('audio', '音频：'),
    ];
  } else if (type === 'audio') {
    parts = [
      pick('kind', '类型：'),
      pick('mood', '氛围：'),
      pick('tempo', '节奏：'),
      pick('transcript', '人声：'),
    ];
  }
  const line = parts.filter((p): p is string => !!p).join('；');
  return line || null;
}

/** 「## 附件理解」消息正文：按附件顺序逐条列出，与 [附件] 清单的 versionId 一一对应 */
export function formatAttachmentAnalysis(
  attachments: readonly AttachmentRef[],
  rows: readonly AnalysisRow[],
): string {
  const byId = new Map(rows.map((r) => [r.versionId, r]));
  const lines = attachments.map((a) => {
    const head = `- ${a.type} versionId=${a.versionId} 文件名 ${a.filename}`;
    const r = byId.get(a.versionId);
    if (!r || !isSettled(r.status)) {
      return `${head}\n  分析中：还没完成，需要时用 get_media_analysis 取（会等它完成）`;
    }
    if (r.status === 'failed') {
      // 写明别再调工具：失败原因多半没变（如服务连不上），重调只会白等
      return `${head}\n  未能分析（${clip(r.error ?? '原因未知', 60)}）：不要再调 get_media_analysis，按文件名推断它是什么，拿不准就用 ask_user 问用户`;
    }
    if (r.status === 'skipped' || !r.summary) {
      return `${head}\n  未分析（该素材无需理解）`;
    }
    const points = keyPoints(a.type, r.detail);
    return [
      head,
      `  摘要：${r.summary}`,
      ...(points ? [`  要点：${points}`] : []),
    ].join('\n');
  });
  return [
    `## 附件理解（本轮 ${attachments.length} 个附件；完整细节用 get_media_analysis(versionId) 取）`,
    ...lines,
  ].join('\n');
}
