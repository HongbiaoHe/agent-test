/**
 * 设计 §5 thread-scoped 沙箱工厂。
 *
 * 为什么单独抽成一个文件？
 * - 沙箱生命周期管理（查找→复用→补拉起 / 创建）对 agent.factory 和 conversations
 *   文件接口都有用，抽出来避免循环依赖。
 * - `getThreadSandbox` 是幂等的：同一 threadId 只维护一个沙箱；如果已停机，
 *   拉起后再返回；如果不存在，新建。
 * - 无 DAYTONA_API_KEY 时静默返回 null，调用方回退到 StateBackend（纯内存/DB）。
 */

import { Daytona } from '@daytonaio/sdk';
import { DaytonaSandbox } from '@langchain/daytona';

// ─── 验证过的 API 事实 ─────────────────────────────────────────────
// @daytonaio/sdk 0.185.0 Daytona.d.ts:
//   · list(query?: ListSandboxesQuery): AsyncIterableIterator<Sandbox>   — 无 findOne
//   · ListSandboxesQuery.labels?: Record<string,string>                  — 按标签过滤
// @daytonaio/sdk Sandbox.d.ts:
//   · state?: SandboxState  （字符串常量枚举，"started"/"stopped" 等）    — 无 isRunning
// @langchain/daytona 0.2.0 index.d.ts:
//   · DaytonaSandbox.create(options?)                                     — 静态工厂
//   · DaytonaSandbox.fromId(id, options?)                                 — 静态，按 SDK sandbox.id 连接
//   · DaytonaSandbox.deleteAll(labels, options?)                          — 静态，按标签批量删
//   · DaytonaSandbox.isRunning: boolean                                   — 实例 getter
//   · DaytonaSandbox.start(timeout?)                                      — 实例方法
//   · DaytonaSandboxOptions.autoStopInterval / autoDeleteInterval          — 单位：分钟
//     （JSDoc: "Auto-stop interval in minutes", "Auto-delete interval in minutes"）
// ──────────────────────────────────────────────────────────────────

/**
 * 按 threadId 获取（或创建）对应的 Daytona 沙箱。
 *
 * 逻辑：
 *  1. 无 DAYTONA_API_KEY → 立即返回 null（调用方用 StateBackend 兜底）。
 *  2. 用 Daytona SDK list() 按 thread_id 标签查找已有沙箱。
 *  3. 找到 → fromId 拿 DaytonaSandbox wrapper；若沙箱停机，先 start() 再返回。
 *     （停机实例 execute/downloadFiles 会失败，必须先拉起——设计 §5 停机恢复）
 *  4. 未找到（list 为空）→ create 新沙箱，绑 thread_id 标签。
 *
 * 错误处理策略（设计 §5）：
 *  - "未找到" 和 "其他错误" 在 SDK 里均抛出异常（list 迭代不返回 undefined）。
 *    为简化起见，任何异常都进入 create 路径——与官方文档示例一致。
 *    这样做的代价：鉴权失败时也会尝试 create，而 create 同样会失败并向上抛出，
 *    调用方（agent worker）会捕获并降级为 StateBackend，行为正确。
 *    如果日后需要区分，可检查 error.code === "AUTHENTICATION_FAILED"（DaytonaSandboxError）。
 */
export async function getThreadSandbox(threadId: string): Promise<DaytonaSandbox | null> {
  if (!process.env.DAYTONA_API_KEY) return null;

  try {
    // 用底层 Daytona SDK 查找已有沙箱（DaytonaSandbox 无 list 能力，需原生 SDK）
    const client = new Daytona();
    const iter = client.list({ labels: { thread_id: threadId } });
    const { value: existing, done } = await iter.next();

    if (!done && existing) {
      // 找到已有沙箱：用 LangChain wrapper 连接，以便 execute/upload 等高级方法可用
      const sb = await DaytonaSandbox.fromId(existing.id);
      if (!sb.isRunning) {
        // 停机沙箱须先显式拉起（停机时 execute/downloadFiles 会失败）
        await sb.start();
      }
      return sb;
    }
  } catch {
    // 任何查找错误（网络、鉴权、未找到等）均降级到下面的 create 路径
  }

  // 创建新沙箱，绑定 thread_id 标签供下次查找
  // autoStopInterval: 15 分钟空闲即停（单位：分钟，已验证）
  // autoDeleteInterval: 60 分钟后自动删除（单位：分钟，已验证；设计 §5 要求 1h）
  return DaytonaSandbox.create({
    labels: { thread_id: threadId },
    autoStopInterval: 15,   // 闲置 15 分钟自动停机，停机态只计存储费用
    autoDeleteInterval: 60, // 停机 60 分钟后自动删除（设计 §5）
  });
}

/**
 * 只查不建（conversations 文件接口用）。
 *
 * - 找到且在运行 → 直接返回。
 * - 找到但停机   → start() 拉起后返回（downloadFiles 对停机实例会失败）。
 * - 未找到       → 返回 null。
 * - 任何错误     → 返回 null（调用方做好 null 检查即可）。
 */
export async function findThreadSandbox(threadId: string): Promise<DaytonaSandbox | null> {
  if (!process.env.DAYTONA_API_KEY) return null;

  try {
    const client = new Daytona();
    const iter = client.list({ labels: { thread_id: threadId } });
    const { value: existing, done } = await iter.next();

    if (done || !existing) return null;

    const sb = await DaytonaSandbox.fromId(existing.id);
    if (!sb.isRunning) {
      await sb.start();
    }
    return sb;
  } catch {
    return null;
  }
}
