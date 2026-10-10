import {
  CompositeBackend,
  StateBackend,
  StoreBackend,
  type EditResult,
  type FileUploadResponse,
  type WriteResult,
} from 'deepagents';
import { InMemoryStore } from '@langchain/langgraph';
import { absolutizeRefPaths } from '../skills/skill-files';
import type { CanvasSkillDef } from './canvas-skills.service';

/**
 * 画布 agent 的虚拟文件系统：默认 StateBackend（画布 agent 不接沙箱），`/skills/` 路由到一个
 * **只读**的 StoreBackend——技能按 deepagents 规范以 `/skills/<名>/SKILL.md` 的形式出现，
 * 模型用 read_file 按需读取（progressive disclosure 的第二、三层），而不是开场全部塞进上下文。
 *
 * 每次 run 新建一份内存 store 并灌入该用户此刻启用的技能；运行中 save_skill 新存的技能经
 * {@link SkillsLibrary.put} 补进去，当轮就能读到。
 */

/** store 命名空间（每 run 一个 store，无需按用户再分） */
const NS = ['canvas-skills'];

/** 技能库只读：写只能经 save_skill（要校验规范、落库、可能要用户确认），不能让 write_file 绕过去 */
class ReadOnlyStoreBackend extends StoreBackend {
  write(filePath: string, _content: string): Promise<WriteResult> {
    return Promise.resolve({
      error: `${filePath} 只读：技能库不能直接写，创建或修改技能请用 save_skill`,
    });
  }

  edit(
    filePath: string,
    _oldString: string,
    _newString: string,
    _replaceAll?: boolean,
  ): Promise<EditResult> {
    return Promise.resolve({
      error: `${filePath} 只读：技能库不能直接改，修改技能请用 save_skill`,
    });
  }

  uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    return Promise.resolve(
      files.map(([path]) => ({ path, error: 'permission_denied' as const })),
    );
  }
}

export interface SkillsLibrary {
  /** 传给 createDeepAgent 的 backend */
  backend: CompositeBackend;
  /** 运行中新存/覆盖了一个技能：补进 store，当轮 read_file 即可读到 */
  put(skill: Pick<CanvasSkillDef, 'name' | 'files'>): Promise<void>;
}

export async function createSkillsLibrary(
  skills: readonly Pick<CanvasSkillDef, 'name' | 'files'>[],
): Promise<SkillsLibrary> {
  const store = new InMemoryStore();
  const put = async (skill: Pick<CanvasSkillDef, 'name' | 'files'>) => {
    const now = new Date().toISOString();
    for (const [rel, raw] of Object.entries(skill.files)) {
      // SKILL.md 里的 ./references/x.md 改写成 /skills/<名>/references/x.md：
      // read_file 只认绝对路径，相对路径会被规整到根目录而 404（主 agent 实测踩过）
      const content =
        rel === 'SKILL.md' ? absolutizeRefPaths(skill.name, raw) : raw;
      // 键是**挂载点相对路径**：CompositeBackend 委派前会剥掉 '/skills' 前缀，
      // 带上前缀会变成 /skills/skills/... 双前缀（主 agent 实测踩过）
      await store.put(NS, `/${skill.name}/${rel}`, {
        content,
        mimeType: 'text/markdown',
        created_at: now,
        modified_at: now,
      });
    }
  };
  for (const s of skills) await put(s);

  const backend = new CompositeBackend(new StateBackend(), {
    '/skills/': new ReadOnlyStoreBackend({ store, namespace: NS }),
  });
  return { backend, put };
}
