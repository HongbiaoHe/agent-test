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
    return { error: `${filePath} is read-only (skills library)` } as WriteResult;
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
    return { error: `${filePath} is read-only (skills library)` } as EditResult;
  }
}

/**
 * beforeAgent 同步用：把 store 内该 userId namespace 下全部技能文件
 * 转换成 uploadFiles 所需的 [path, Uint8Array][] 格式。
 *
 * store.search 返回的 Item.key 即文件路径，Item.value.content 是行数组（StoreBackend 写入格式）。
 * join('\n') 还原文本内容，TextEncoder 转 Uint8Array。
 */
export async function buildSkillSyncFiles(
  store: BaseStore,
  userId: string,
): Promise<Array<[string, Uint8Array]>> {
  const enc = new TextEncoder();
  const items = await store.search([userId, 'skills'], { limit: 1000 });
  return items.map((i) => [
    String(i.key),
    enc.encode(((i.value as { content?: string[] }).content ?? []).join('\n')),
  ]);
}
