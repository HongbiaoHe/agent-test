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

/** 不合法的原因；文案键为 errors.workspace.<原因>，由调用方（main / agent-host）按各自的语言翻译 */
export type WorkspaceDirProblem = 'notAbsolute' | 'singleQuote';

/** 工作区路径约束：绝对路径；不含单引号（GuardedSandbox.execute 用单引号包路径） */
export function validateWorkspaceDir(dir: string): WorkspaceDirProblem | null {
  // renderer 也会引用本文件，不能依赖 node:path
  if (!/^(\/|[A-Za-z]:[\\/])/.test(dir)) return 'notAbsolute';
  if (dir.includes("'")) return 'singleQuote';
  return null;
}
