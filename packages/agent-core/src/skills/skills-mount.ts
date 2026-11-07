import { createHash } from 'node:crypto';
import { InMemoryStore } from '@langchain/langgraph';
import {
  type AnyBackendProtocol,
  CompositeBackend,
  type EditResult,
  StateBackend,
  StoreBackend,
  type WriteResult,
} from 'deepagents';
import type { GuardedSandbox } from '../agent/guarded-sandbox';
import type { SkillFiles } from '../modes/resolve-mode';
import { absolutizeRefPaths } from './skill-files';

/**
 * 技能挂载（core 统一负责，宿主只给技能文件清单）：
 *   - sandbox：写进沙箱盘 `${skillsDir}/<name>/...`，技能里的脚本能被 execute 跑到；
 *   - memory：无沙箱时把技能灌进内存只读 StoreBackend，经 CompositeBackend 路由到 skillsDir。
 * 两种情况下模型看到的路径一致（`${skillsDir}/<name>/SKILL.md`），提示词里的技能引用不用区分环境。
 * desktop 的本机目录挂载是第三种策略，仍由 desktop 自己的 buildWorkspaceBackend 负责。
 */

const SKILLS_MANIFEST_NAME = '.manifest';

/** 技能库只读：写只能经宿主的 save_skill 之类工具，不能让 write_file 绕过去 */
class ReadOnlyStoreBackend extends StoreBackend {
  override write(filePath: string, _content: string): Promise<WriteResult> {
    return Promise.resolve({
      error: `${filePath} 只读：技能库不能直接写，创建或修改技能请用专门的工具`,
    });
  }

  override edit(
    filePath: string,
    _oldString: string,
    _newString: string,
    _replaceAll?: boolean,
  ): Promise<EditResult> {
    return Promise.resolve({
      error: `${filePath} 只读：技能库不能直接改，修改技能请用专门的工具`,
    });
  }
}

export type MountSkillsInput =
  | {
      strategy: 'memory';
      /** agent 眼中的技能库目录（如 /skills） */
      skillsDir: string;
      skills: readonly SkillFiles[];
      /** 技能库之外的默认 backend；缺省 new StateBackend() */
      base?: AnyBackendProtocol;
    }
  | {
      strategy: 'sandbox';
      sandbox: GuardedSandbox;
      skills: readonly SkillFiles[];
    };

export interface MountedSkills {
  backend: AnyBackendProtocol;
  skillsDir: string;
}

export async function mountSkills(
  input: MountSkillsInput,
): Promise<MountedSkills> {
  if (input.strategy === 'sandbox') {
    await uploadSkillsToSandbox(input.sandbox, input.skills);
    return { backend: input.sandbox, skillsDir: input.sandbox.skillsDir };
  }
  const skillsDir = input.skillsDir.replace(/\/+$/, '');
  const store = new InMemoryStore();
  const namespace = ['skills'];
  const now = new Date().toISOString();
  for (const skill of input.skills) {
    for (const [rel, raw] of Object.entries(skill.files)) {
      // SKILL.md 的 ./references/x.md 改写成绝对路径：read_file 只认绝对路径
      const content =
        rel === 'SKILL.md'
          ? absolutizeRefPaths(skill.name, raw, skillsDir)
          : raw;
      // 键是**挂载点相对路径**：CompositeBackend 委派前会剥掉挂载点前缀，带上会双前缀
      await store.put(namespace, `/${skill.name}/${rel}`, {
        content,
        mimeType: 'text/markdown',
        created_at: now,
        modified_at: now,
      });
    }
  }
  const backend = new CompositeBackend(input.base ?? new StateBackend(), {
    [`${skillsDir}/`]: new ReadOnlyStoreBackend({ store, namespace }),
  });
  return { backend, skillsDir };
}

/**
 * 把技能写进沙箱盘（从 backend agent/sandbox.ts 搬来，语义不变）。
 * deepagents 的 skills 中间件在 beforeAgent 通过 ls + downloadFiles 扫 skillsDir，
 * 故必须在 agent.stream 之前完成上传，模型才能在系统提示里看到技能清单。
 *
 * 幂等去重（防每轮重复上传）：用户级沙箱跨会话/多轮共享，每条消息都会进 process。
 * 先算技能集指纹（名+路径+内容的 sha256），与沙箱内 `.manifest` 比对：
 *  - 一致 → 直接跳过，省掉一整轮文件上传（仅 1 次小文件下载）；
 *  - 不一致（首次/新沙箱/技能增删改/启停/换模式）→ 先清空旧技能目录（去除被禁用/删除/
 *    未勾选技能的残留），再全量上传并写入新指纹。
 *
 * SKILL.md 经 absolutizeRefPaths 把相对引用改写为 `${skillsDir}/<name>/...` 绝对路径；
 * 任一文件上传失败即抛错，由调用方降级（沙箱可用但技能缺失没有意义）。
 */
export async function uploadSkillsToSandbox(
  sb: GuardedSandbox,
  defs: readonly SkillFiles[],
): Promise<void> {
  const enc = new TextEncoder();
  const skillsDir = sb.skillsDir;
  const manifestPath = `${skillsDir}/${SKILLS_MANIFEST_NAME}`;
  // 收集 [agent 路径, 文本] 并按路径排序，保证指纹与上传内容确定、与 defs 顺序无关
  const entries: Array<{ path: string; text: string }> = [];
  for (const def of defs) {
    for (const [rel, content] of Object.entries(def.files)) {
      const text =
        rel === 'SKILL.md'
          ? absolutizeRefPaths(def.name, content, skillsDir)
          : content;
      entries.push({ path: `${skillsDir}/${def.name}/${rel}`, text });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash('sha256')
    .update(entries.map((e) => `${e.path}\n${e.text}`).join('\0'))
    .digest('hex');

  // 与沙箱内上次指纹比对：一致则跳过（下载失败/缺失 = 视为不一致，照常上传）
  const [manifest] = await sb.downloadFiles([manifestPath]);
  if (
    manifest &&
    !manifest.error &&
    manifest.content &&
    new TextDecoder().decode(manifest.content) === fingerprint
  ) {
    return;
  }

  // 指纹变化：先清空旧技能目录（execute 已 cd 到工作区根，相对路径 skills 即 ws/skills），
  // 再全量重建——避免被禁用/删除/未勾选的技能文件残留被 skills 中间件继续扫到。
  await sb.execute(`rm -rf skills`);

  const files: Array<[string, Uint8Array]> = entries.map((e) => [
    e.path,
    enc.encode(e.text),
  ]);
  // 指纹清单一并写入（.manifest 是文件，skills 中间件只认目录，不会被当成技能）
  files.push([manifestPath, enc.encode(fingerprint)]);

  const results = await sb.uploadFiles(files);
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    throw new Error(
      `技能上传沙箱失败 ${failed.length}/${files.length}：${failed[0].path} ${failed[0].error}`,
    );
  }
}
