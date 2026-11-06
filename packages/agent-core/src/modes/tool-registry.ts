import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Capability, RuntimeEnvironment } from './capabilities';

/**
 * 工具注册表：宿主启动时把自己的工具描述符登记进来，模式按 name 勾选，resolveMode 按 requires 过滤。
 * 业务服务（MediaService 等）由宿主在注册处闭包捕获，core 不认识任何业务类型；运行期对象
 * （沙箱实例、本轮 MCP server 清单）经 ToolCreateContext.host 传入，类型由宿主自定（泛型 H）。
 */

export interface ToolCreateContext<H = unknown> {
  conversationId: string;
  userId: string;
  env: RuntimeEnvironment;
  /** 宿主自定义的运行期对象，core 不解释 */
  host: H;
}

/** 需审批：true = 默认决策集；带 allowedDecisions = 限定前端可选的决策（如 ask_user 只允许 approve/edit） */
export type ToolInterruptOn = true | { allowedDecisions: string[] };

export interface ToolDescriptor<H = unknown> {
  /** 模型看到的工具名，也是模式里勾选的 key */
  name: string;
  /** 设置页展示用 */
  title: string;
  description: string;
  /** 运行环境必须具备的能力；任一缺失 → 本轮不装配 */
  requires?: readonly Capability[];
  create: (ctx: ToolCreateContext<H>) => StructuredToolInterface;
  interruptOn?: ToolInterruptOn;
  /**
   * 勾选该工具（且本环境装配得了）时追加到系统提示的说明段；按生成后的文本去重，多个工具共享同一段只拼一次。
   * 段落内容随环境变化时传函数（如后台任务段：有沙箱才提 run_in_background）。
   */
  promptSection?: string | ((env: RuntimeEnvironment) => string);
}

/** 设置页目录项（不含 create 闭包，可序列化） */
export type ToolCatalogEntry = Pick<
  ToolDescriptor,
  'name' | 'title' | 'description' | 'requires'
>;

export class ToolRegistry<H = unknown> {
  private readonly byName = new Map<string, ToolDescriptor<H>>();

  register(descriptor: ToolDescriptor<H>): this {
    if (this.byName.has(descriptor.name)) {
      throw new Error(`工具重复注册：${descriptor.name}`);
    }
    this.byName.set(descriptor.name, descriptor);
    return this;
  }

  registerAll(descriptors: readonly ToolDescriptor<H>[]): this {
    for (const d of descriptors) this.register(d);
    return this;
  }

  get(name: string): ToolDescriptor<H> | undefined {
    return this.byName.get(name);
  }

  /** 按注册顺序 */
  list(): ToolDescriptor<H>[] {
    return [...this.byName.values()];
  }

  catalog(): ToolCatalogEntry[] {
    return this.list().map(({ name, title, description, requires }) => ({
      name,
      title,
      description,
      requires: requires ?? [],
    }));
  }
}

/**
 * 一个工厂出多把工具（如 createMediaTools 一次出 5 把、共享同一份闭包）时拆成多条描述符，
 * 同一 ctx 只调一次工厂、按 name 分发。模式按单个工具名勾选，但底层工厂不用拆。
 */
export function shareFactory<H>(
  factory: (ctx: ToolCreateContext<H>) => StructuredToolInterface[],
  entries: readonly Omit<ToolDescriptor<H>, 'create'>[],
): ToolDescriptor<H>[] {
  const cache = new WeakMap<ToolCreateContext<H>, StructuredToolInterface[]>();
  const toolsFor = (ctx: ToolCreateContext<H>) => {
    let tools = cache.get(ctx);
    if (!tools) {
      tools = factory(ctx);
      cache.set(ctx, tools);
    }
    return tools;
  };
  return entries.map((entry) => ({
    ...entry,
    create: (ctx) => {
      const found = toolsFor(ctx).find((t) => t.name === entry.name);
      if (!found) {
        throw new Error(`shareFactory：工厂没有产出名为 ${entry.name} 的工具`);
      }
      return found;
    },
  }));
}
