import { StoreBackend, type WriteResult, type EditResult } from 'deepagents';
import type { BaseStore } from '@langchain/langgraph';

/**
 * /skills/ 路由只读（官方 §9.5 policy hook 模式）：
 * 防 agent 在运行时直接 write/edit 技能库，避免跨线程污染。
 * 只读拦截在此层完成，read / ls / grep / uploadFiles（同步专用）不受限。
 */
export class ReadOnlyStoreBackend extends StoreBackend {
  /**
   * 覆盖 write——技能库只读，直接返回 error，不触碰 store。
   * 基类签名：write(filePath, content) → Promise<WriteResult>
   */
  async write(filePath: string, _content: string): Promise<WriteResult> {
    return {
      error: `${filePath} is read-only (skills library)`,
    };
  }

  /**
   * 覆盖 edit——同上，直接返回 error，不触碰 store。
   * 基类签名：edit(filePath, oldString, newString, replaceAll?) → Promise<EditResult>
   */
  async edit(
    filePath: string,
    _oldString: string,
    _newString: string,
    _replaceAll?: boolean,
  ): Promise<EditResult> {
    return { error: `${filePath} is read-only (skills library)` };
  }
}

/**
 * beforeAgent 同步用：把 store 内该 userId namespace 下全部技能文件
 * 转换成 uploadFiles 所需的 [path, Uint8Array][] 格式。
 *
 * store.search 返回的 Item.key 是**挂载点相对路径**（如 '/docx/SKILL.md'，见 skill-store.seed），
 * 上传到沙箱时要补回 '/skills' 挂载前缀——SKILL.md 指示模型 execute 的脚本路径是
 * /skills/<name>/scripts/*（模型视角路径空间），沙箱文件系统里必须落在同一路径。
 * 官方文档同款写法：files.push([`/skills${normalized}`, ...])。
 */
export async function buildSkillSyncFiles(
  store: BaseStore,
  userId: string,
): Promise<Array<[string, Uint8Array]>> {
  const enc = new TextEncoder();
  const items = await store.search([userId, 'skills'], { limit: 1000 });
  return items.map((i) => [
    `/skills${String(i.key)}`,
    enc.encode(((i.value as { content?: string[] }).content ?? []).join('\n')),
  ]);
}
