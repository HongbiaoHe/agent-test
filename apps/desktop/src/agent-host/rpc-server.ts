/**
 * RPC 分发：把 renderer 的请求（经 MessagePort）路由到各服务。参数先用 shared/rpc 的 zod schema 校验。
 */
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { ALLOWED_MODELS } from '@agent-test/agent-core/agent/models';
import { thinkingLevelsFor } from '@agent-test/agent-core/agent/thinking-level';
import {
  type ModelOption,
  rpcSchemas,
  type RpcMethod,
  type RpcParsedParams,
  type RpcResults,
} from '../shared/rpc';
import { validateWorkspaceDir } from '../shared/workspace';
import type { ConversationRepo } from './db/conversations';
import type { BackgroundService } from './background/background-service';
import { McpError, type McpStore } from './mcp/mcp-store';
import type { RunConfig, RunService } from './run/run-service';
import { parseSkillSource, skillsAddArgs } from './skills/github-install';
import type { SkillStore } from './skills/skill-store';
import type { WebApi } from './web-media/web-api';
import { listDir, readFilePreview } from './workspace/files';

export interface Services {
  repo: ConversationRepo;
  runs: RunService;
  skills: SkillStore;
  mcp: McpStore;
  config: () => RunConfig & { keys: { google: boolean; deepseek: boolean } };
  listChanged: () => void;
  mcpChanged: () => void;
  skillsChanged: () => void;
  background: BackgroundService;
  webApi: WebApi | null;
}

function requireWeb(s: Services): WebApi {
  if (!s.webApi) throw new Error('还没有登录 Web 账号：在设置里登录后才能使用生图 / 生视频 / 配音');
  return s.webApi;
}

/** 展示名与 apps/frontend/src/app/agent/_lib/models.ts 保持一致的口径：provider + 型号 */
function modelOptions(): ModelOption[] {
  return ALLOWED_MODELS.map((id) => {
    const [provider, name] = id.split(':');
    return {
      id,
      label: name,
      provider: provider === 'deepseek' ? 'deepseek' : 'google',
      thinkingLevels: thinkingLevelsFor(id),
    };
  });
}

/** 会话工作区必须是已存在的目录（由文件夹选择器选出），路径约束同 GuardedSandbox */
async function assertWorkspaceDir(dir: string): Promise<string> {
  const err = validateWorkspaceDir(dir);
  if (err) throw new Error(err);
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`目录不存在：${dir}`);
  return dir;
}

type Handlers = {
  [M in RpcMethod]: (params: RpcParsedParams<M>) => Promise<RpcResults[M]> | RpcResults[M];
};

export function createHandlers(s: Services): Handlers {
  return {
    'host.status': () => {
      const c = s.config();
      return {
        workspaceDir: c.workspaceDir,
        keys: c.keys,
        defaultModel: c.defaultModel,
      };
    },
    'models.list': () => modelOptions(),
    'conversations.list': () => s.repo.list(),
    'conversations.create': async (p) => {
      const dir = p.workspaceDir ? await assertWorkspaceDir(p.workspaceDir) : undefined;
      const c = s.repo.create(p.model ?? s.config().defaultModel, {
        dir,
        permission: p.permission,
      });
      s.listChanged();
      return c;
    },
    'conversations.get': (p) => ({
      conversation: s.repo.require(p.id),
      messages: s.repo.messages(p.id),
      totalTokens: s.repo.totalTokens(p.id),
    }),
    'conversations.update': async (p) => {
      if (p.workspaceDir) s.repo.setWorkspaceDir(p.id, await assertWorkspaceDir(p.workspaceDir));
      if (p.permission) s.repo.setPermission(p.id, p.permission);
      const c = s.repo.update(p.id, {
        title: p.title,
        model: p.model,
        thinkingLevel: p.thinkingLevel,
      });
      s.listChanged();
      return c;
    },
    'conversations.tokenReport': (p) => s.repo.tokenReport(p.id),
    'background.list': (p) => s.background.list(p.conversationId),
    'media.list': (p) =>
      requireWeb(s).get(`/media-api/generations?scope=${encodeURIComponent(p.conversationId)}`),
    'media.regenerate': (p) =>
      requireWeb(s).post(`/media/generations/${encodeURIComponent(p.generationId)}/regenerate`, {
        prompt: p.prompt,
        referenceVersionIds: p.referenceVersionIds,
      }),
    'media.source': async (p) =>
      z
        .object({ url: z.string().nullable() })
        .parse(await requireWeb(s).get(`/media/versions/${encodeURIComponent(p.versionId)}/source`)),
    'web.status': () => ({ enabled: !!s.webApi, apiUrl: s.webApi?.baseUrl ?? null }),
    'background.cancel': (p) => s.background.cancel(p.taskId),
    'workspace.list': async (p) => {
      const root = s.repo.require(p.conversationId).workspaceDir;
      return { root, entries: await listDir(root, p.path) };
    },
    'workspace.read': (p) => readFilePreview(s.repo.require(p.conversationId).workspaceDir, p.path),
    'conversations.delete': async (p) => {
      if (s.runs.isRunning(p.id)) s.runs.stop(p.id);
      s.background.cancelByConversation(p.id);
      s.repo.delete(p.id);
      await s.runs.forgetThread(p.id);
      s.listChanged();
      return { ok: true };
    },
    'run.start': async (p) => {
      await s.runs.start(p.conversationId, p.text, p.attachments);
      return { ok: true };
    },
    'run.resume': (p) => {
      s.runs.resume(p.conversationId, p.decisions);
      return { ok: true };
    },
    'run.stop': (p) => {
      s.runs.stop(p.conversationId);
      return { ok: true };
    },
    'skills.list': () => s.skills.list(),
    'skills.get': (p) => s.skills.detail(p.name),
    'skills.install': async (p) => {
      const v = await s.skills.installFromFolder(p.folder);
      s.skillsChanged();
      return v;
    },
    'skills.installFromGithub': async (p) => {
      const v = await s.skills.installFromGithub(parseSkillSource(skillsAddArgs(p.source) ?? p.source));
      s.skillsChanged();
      return v;
    },
    'skills.saveCustom': async (p) => {
      if (p.mode === 'create' && (await s.skills.get(p.name))) {
        throw new Error(`已经有名为 ${p.name} 的技能`);
      }
      const v = await s.skills.saveCustom({
        name: p.name,
        description: p.description,
        body: p.body,
        mustExist: p.mode === 'edit',
      });
      s.skillsChanged();
      return v;
    },
    'skills.setEnabled': async (p) => {
      const v = await s.skills.setEnabled(p.name, p.enabled);
      s.skillsChanged();
      return v;
    },
    'skills.remove': async (p) => {
      await s.skills.remove(p.name);
      s.skillsChanged();
      return { ok: true };
    },
    'mcp.list': () => s.mcp.list(),
    'mcp.add': async (p) => {
      const r = await s.mcp.add(p.url, p.name);
      s.mcpChanged();
      return r;
    },
    'mcp.addPreset': async (p) => {
      const r = await s.mcp.addPreset(p.key);
      s.mcpChanged();
      return r;
    },
    'mcp.remove': (p) => {
      s.mcp.remove(p.id);
      s.mcpChanged();
      return { deleted: true };
    },
    'mcp.connect': async (p) => {
      const r = await s.mcp.connect(p.id);
      s.mcpChanged();
      return r;
    },
    'mcp.disconnect': (p) => {
      const v = s.mcp.disconnect(p.id);
      s.mcpChanged();
      return v;
    },
    'mcp.update': (p) => {
      const v = s.mcp.update(p.id, { enabled: p.enabled, toolPermissions: p.toolPermissions });
      s.mcpChanged();
      return v;
    },
    'mcp.appResource': (p) => s.mcp.appResource(p.serverId, p.uri),
    'mcp.readResource': (p) => s.mcp.readResource(p.serverId, p.uri),
    // server 自己报的执行失败以 isError 结果回给 App（同 backend apps/call-tool），权限类错误照常抛
    'mcp.callToolFromApp': async (p) => {
      try {
        return await s.mcp.callToolFromApp(p.serverId, p.name, p.arguments ?? {}, p.confirmed === true);
      } catch (e) {
        if (e instanceof McpError) throw e;
        return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
      }
    },
    'mcp.setAppContext': (p) => {
      s.mcp.setAppContext(p.conversationId, p.toolCallId, p.serverId, p.text);
      return { ok: true };
    },
  };
}

/** 校验参数并调用对应处理函数 */
export async function dispatch(
  handlers: Handlers,
  method: RpcMethod,
  params: unknown,
): Promise<unknown> {
  // await：参数校验（zod parse）同步抛错时也落成 rejected promise，调用方统一 .then 处理
  return await call(handlers, method, params);
}

function call<M extends RpcMethod>(handlers: Handlers, method: M, params: unknown) {
  // rpcSchemas[M] 解析出的正是 RpcParsedParams<M>；TS 无法把「按键取出的 schema」与键关联
  // （correlated union 限制），这里只能断言一次，运行时已由 zod 校验过形状
  const parsed = rpcSchemas[method].parse(params ?? {}) as RpcParsedParams<M>;
  return handlers[method](parsed);
}
