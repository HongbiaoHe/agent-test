/**
 * 运行环境描述：core 不认识 Daytona / E2B / 本机目录，只看宿主报上来的能力集。
 * 工具描述符声明 requires，resolveMode 对照过滤；不满足的工具降级跳过并在系统提示里列出。
 * 封闭集：新能力改 core 加，不让宿主自造字符串。
 */
export type Capability =
  /** 远程沙箱（execute 可用、技能脚本可跑） */
  | 'sandbox'
  /** 有可读工作区（沙箱或本机目录） */
  | 'workspace'
  /** 工作区可写（desktop 只读档位没有） */
  | 'workspace_write'
  /** 生图 / 生视频 / 配音服务可达 */
  | 'media_api'
  /** 可外发邮件 */
  | 'email'
  /** 后台任务服务可用 */
  | 'background';

export const CAPABILITIES: readonly Capability[] = [
  'sandbox',
  'workspace',
  'workspace_write',
  'media_api',
  'email',
  'background',
];

export interface RuntimeEnvironment {
  capabilities: ReadonlySet<Capability>;
  /** agent 眼中的工作区路径；无工作区为 undefined */
  workspace?: string;
  /** 技能库目录（agent 眼中的路径，如 /workspace/skills；无工作区时 /skills） */
  skillsDir: string;
}
