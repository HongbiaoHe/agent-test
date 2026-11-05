/**
 * 会话工作区：用户为每个会话选择的本机目录 + 权限档位（main 与 agent-host 共用的约束）。
 */
/**
 * 权限档位：
 * - read_only：只能读文件，写文件 / 改文件 / 执行命令一律拒绝；
 * - ask：写文件、改文件、执行命令都要用户逐条批准；
 * - auto：在工作区内自动执行，不弹审批。
 */
export const WORKSPACE_PERMISSIONS = ['read_only', 'ask', 'auto'] as const;
export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export const DEFAULT_PERMISSION: WorkspacePermission = 'ask';

/** 工作区路径约束：绝对路径；不含单引号（GuardedSandbox.execute 用单引号包路径） */
export function validateWorkspaceDir(dir: string): string | null {
  // renderer 也会引用本文件，不能依赖 node:path
  if (!/^(\/|[A-Za-z]:[\\/])/.test(dir)) return '工作区必须是绝对路径';
  if (dir.includes("'")) return "工作区路径不能包含单引号（'）";
  return null;
}
