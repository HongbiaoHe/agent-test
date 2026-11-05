import type { BaseSandbox } from 'deepagents';

/**
 * GuardedSandbox 能包装的 inner：deepagents BaseSandbox（execute/upload/download +
 * 基于 shell 的文件工具）+ 宿主侧生命周期方法。DaytonaSandbox、E2BSandbox（backend）与 desktop 的本机适配器均满足。
 */
export type GuardableSandbox = BaseSandbox & {
  readonly isRunning: boolean;
  start(timeout?: number): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  /**
   * 一轮 agent 运行期间由 worker 定期调用（30s），把闲置计时推到「现在 + 闲置时长」。
   * E2B 的超时是绝对时长、只在文件/命令操作前续期：模型思考或长命令执行超过闲置时长，
   * 沙箱会在轮内暂停、后续工具调用全部失败——闲置 1 分钟时这是常态而非偶发。
   * 不需要的提供方（Daytona 由服务端按活动计时）不实现。
   */
  heartbeat?(): Promise<void>;
};
