/**
 * 一轮运行的 agent backend：用户自选的工作区 + 应用管理的只读运行目录。
 *
 * 工作区是用户为会话选的任意本机目录（可能是他自己的项目），所以技能库与附件副本不再放进去
 * （旧做法每轮 rm -rf `<工作区>/skills` 再写入，会误删项目里同名目录），而是放在
 * `<userData>/runtime/<会话 id>/`（skills/ + attachments/），经 CompositeBackend 按真实绝对路径
 * 前缀路由到只读的 FilesystemBackend：
 *   - 文件工具读得到（技能中间件扫 `${runtimeDir}/skills/`、read_file 读附件）；
 *   - execute 跑在本机，同一条绝对路径直接可用（`python3 <runtimeDir>/skills/x/scripts/a.py`）；
 *   - write / edit 一律拒绝。
 * 其余路径落到 GuardedSandbox(工作区)；read_only 档位再把它的写与执行也拒掉。
 */
import { GuardedSandbox } from '@agent-test/agent-core/agent/guarded-sandbox';
import {
  CompositeBackend,
  type EditResult,
  type ExecuteResponse,
  type FileUploadResponse,
  FilesystemBackend,
  type WriteResult,
} from 'deepagents';
import type { WorkspacePermission } from '../../shared/workspace';
import type { LocalWorkspaceSandbox } from './local-sandbox';

/** 运行目录：技能与附件副本都在这里，agent 只读 */
class ReadOnlyFilesystemBackend extends FilesystemBackend {
  override write(filePath: string): Promise<WriteResult> {
    return Promise.resolve({ error: `只读目录，禁止写入：${filePath}` });
  }

  override edit(filePath: string): Promise<EditResult> {
    return Promise.resolve({ error: `只读目录，禁止修改：${filePath}` });
  }

  override uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' as const })));
  }
}

/** read_only 档位：工作区只能读，写 / 改 / 执行命令都返回错误（不弹审批，直接拒） */
class ReadOnlyGuardedSandbox extends GuardedSandbox {
  override write(filePath: string): Promise<WriteResult> {
    return Promise.resolve({ error: `当前会话是只读权限，不能写文件：${filePath}` });
  }

  override edit(filePath: string): Promise<EditResult> {
    return Promise.resolve({ error: `当前会话是只读权限，不能修改文件：${filePath}` });
  }

  override execute(): Promise<ExecuteResponse> {
    return Promise.resolve({
      output: '当前会话是只读权限，不能执行命令。需要执行时请让用户在会话顶栏把权限改为「询问」或「自动」。',
      exitCode: 1,
      truncated: false,
    });
  }

  override uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' as const })));
  }
}

export interface WorkspaceBackend {
  backend: CompositeBackend;
  /** 工作区那一侧（列目录 / 宿主侧读文件用） */
  workspace: GuardedSandbox;
  /** agent 眼中的技能库目录 */
  skillsDir: string;
}

export function buildWorkspaceBackend(opts: {
  inner: LocalWorkspaceSandbox;
  workspaceDir: string;
  runtimeDir: string;
  permission: WorkspacePermission;
}): WorkspaceBackend {
  const Sandbox = opts.permission === 'read_only' ? ReadOnlyGuardedSandbox : GuardedSandbox;
  const workspace = new Sandbox(opts.inner, opts.workspaceDir, opts.workspaceDir);
  const runtime = new ReadOnlyFilesystemBackend({ rootDir: opts.runtimeDir, virtualMode: true });
  return {
    backend: new CompositeBackend(workspace, { [`${opts.runtimeDir}/`]: runtime }),
    workspace,
    skillsDir: `${opts.runtimeDir}/skills`,
  };
}

/**
 * 各档位需要审批的工具：ask = 写 / 改 / 执行（含后台命令 run_in_background）都要批；
 * read_only 已在 backend 层直接拒（且不提供后台命令）；auto 全放行。
 */
export function permissionInterrupts(permission: WorkspacePermission): Record<string, true> {
  if (permission !== 'ask') return {};
  return {
    execute: true,
    write_file: true,
    edit_file: true,
    run_in_background: true,
    // 把媒体下载进工作区 = 写文件
    sync_media_to_sandbox: true,
  };
}
