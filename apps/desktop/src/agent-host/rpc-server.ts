/**
 * RPC 分发：把 renderer 的请求（经 MessagePort）路由到各服务。参数先用 shared/rpc 的 zod schema 校验。
 */
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { ALLOWED_MODELS } from '@agent-test/agent-core/agent/models';
import { thinkingLevelsFor } from '@agent-test/agent-core/agent/thinking-level';
import { GENERAL_MODE_PROMPT } from '@agent-test/agent-core/modes/mode.schema';
import { PROMPT_FRAGMENT_IDS } from '@agent-test/agent-core/modes/prompt-fragments';
import { resolveMode } from '@agent-test/agent-core/modes/resolve-mode';
import type { GeneralModeSettings } from '@agent-test/agent-core/modes/mode.schema';
import {
  type GeneralModeView,
  type ModeCatalog,
  type ModelOption,
  rpcSchemas,
  type RpcMethod,
  type RpcParsedParams,
  type RpcResults,
} from '../shared/rpc';
import { validateWorkspaceDir } from '../shared/workspace';
import type { ConversationRepo } from './db/conversations';
import type { BackgroundService } from './background/background-service';
import { hostI18n } from './i18n';
import { McpError, type McpStore } from './mcp/mcp-store';
import type { ModeStore } from './modes/mode-store';
import type { RunConfig, RunService } from './run/run-service';
import { type DesktopRegistry, desktopCapabilities } from './run/tool-registry';
import { parseSkillSource, skillsAddArgs } from './skills/github-install';
import type { SkillStore } from './skills/skill-store';
import type { VideoService } from './video/video-service';
import type { WebApi } from './web-media/web-api';
import { listDir, readFilePreview } from './workspace/files';

export interface Services {
  repo: ConversationRepo;
  runs: RunService;
  skills: SkillStore;
  mcp: McpStore;
  modes: ModeStore;
  registry: DesktopRegistry;
  config: () => RunConfig & { keys: { google: boolean; deepseek: boolean } };
  listChanged: () => void;
  mcpChanged: () => void;
  skillsChanged: () => void;
  modesChanged: () => void;
  background: BackgroundService;
  webApi: WebApi | null;
  video: VideoService;
}

/** 设置页目录用的能力集：按新会话默认档位（ask）算，运行期再按会话实际权限重算 */
function catalogCapabilities(s: Services) {
  return desktopCapabilities({ permission: 'ask', webApi: s.webApi, background: s.background });
}

async function modeCatalog(s: Services): Promise<ModeCatalog> {
  const skills = await s.skills.list();
  return {
    tools: s.registry.catalog(),
    mcpServers: s.mcp.list().servers.map(({ id, name, slug }) => ({ id, name, slug })),
    skills: skills.filter((x) => x.enabled).map(({ name, description }) => ({ name, description })),
    fragments: [...PROMPT_FRAGMENT_IDS, ...Object.keys(s.modes.customFragments())],
    generalPrompt: s.modes.getGeneral().systemPrompt ?? GENERAL_MODE_PROMPT,
    capabilities: [...catalogCapabilities(s)],
  };
}

function generalModeView(g: GeneralModeSettings): GeneralModeView {
  return {
    systemPrompt: g.systemPrompt ?? GENERAL_MODE_PROMPT,
    isCustom: g.systemPrompt !== null,
    defaultPrompt: GENERAL_MODE_PROMPT,
    defaultModel: g.defaultModel,
    defaultThinkingLevel: g.defaultThinkingLevel,
  };
}

/** 设置页预览的装配环境：能力集同目录（ask 档位），技能目录用占位路径 */
async function previewEnv(s: Services) {
  return {
    registry: s.registry,
    env: { capabilities: catalogCapabilities(s), skillsDir: '<runtime>/skills' },
    installedSkills: await s.skills.listFiles(),
    mcpServers: s.mcp.runtimeServers(),
  };
}

function requireWeb(s: Services): WebApi {
  if (!s.webApi) throw new Error(hostI18n.t('errors.web.notSignedIn'));
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
  if (err) throw new Error(hostI18n.t(`errors.workspace.${err}`));
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(hostI18n.t('errors.workspace.dirNotFound', { dir }));
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
      // 模式被删了就按通用模式建（最近用的 modeId 存在 renderer 本地）；模式（或通用模式设置）的默认模型 /
      // 思考档位只在创建时回填（决策 11）
      const mode = p.modeId ? s.modes.get(p.modeId) : null;
      const defaults = mode ?? s.modes.getGeneral();
      let c = s.repo.create(
        p.model ?? defaults.defaultModel ?? s.config().defaultModel,
        { dir, permission: p.permission },
        mode?.id ?? null,
      );
      if (defaults.defaultThinkingLevel) c = s.repo.update(c.id, { thinkingLevel: defaults.defaultThinkingLevel });
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
      if (p.pinned !== undefined) s.repo.setPinned(p.id, p.pinned);
      if (p.modeId !== undefined) {
        if (p.modeId !== null) s.modes.require(p.modeId);
        s.repo.setMode(p.id, p.modeId);
      }
      // 只改置顶 / 权限 / 目录 / 模式时不走 update：它会刷新 updated_at，置顶会让会话跳到「今天」
      const changesFields = p.title !== undefined || p.model !== undefined || p.thinkingLevel !== undefined;
      const c = changesFields
        ? s.repo.update(p.id, { title: p.title, model: p.model, thinkingLevel: p.thinkingLevel })
        : s.repo.require(p.id);
      s.listChanged();
      return c;
    },
    'modes.list': () => s.modes.list(),
    'modes.create': (p) => {
      const m = s.modes.create(p);
      s.modesChanged();
      return m;
    },
    'modes.update': ({ id, ...input }) => {
      const m = s.modes.update(id, input);
      s.modesChanged();
      return m;
    },
    'modes.delete': (p) => {
      // 引用它的会话退回通用模式：会话列表也要刷新
      if (s.modes.remove(p.id) > 0) s.listChanged();
      s.modesChanged();
      return { ok: true };
    },
    'modes.catalog': () => modeCatalog(s),
    'modes.preview': async (p) => {
      const { systemPrompt, unavailable } = resolveMode({
        mode: { ...p, id: 'preview' },
        fragmentOverrides: s.modes.fragmentOverrides(),
        customFragments: s.modes.customFragments(),
        ...(await previewEnv(s)),
      });
      return { systemPrompt, unavailable };
    },
    'modes.general.get': () => generalModeView(s.modes.getGeneral()),
    'modes.general.update': (p) => {
      const g = s.modes.updateGeneral(p);
      s.modesChanged();
      return generalModeView(g);
    },
    'modes.general.preview': async (p) => {
      const { systemPrompt, unavailable } = resolveMode({
        mode: null,
        generalPrompt: p.systemPrompt,
        fragmentOverrides: s.modes.fragmentOverrides(),
        customFragments: s.modes.customFragments(),
        ...(await previewEnv(s)),
      });
      return { systemPrompt, unavailable };
    },
    'modes.fragments.list': () => s.modes.listFragments(),
    'modes.fragments.update': ({ id, ...patch }) => {
      const f = s.modes.updateFragment(id, patch);
      s.modesChanged();
      return f;
    },
    'modes.fragments.create': (p) => {
      const f = s.modes.createFragment(p);
      s.modesChanged();
      return f;
    },
    'modes.fragments.delete': (p) => {
      s.modes.deleteFragment(p.id);
      s.modesChanged();
      return { ok: true };
    },
    'conversations.search': (p) => s.repo.search(p.query),
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
    'video.list': (p) => s.video.list(p.conversationId),
    'video.read': (p) => s.video.read(p.conversationId, p.path),
    'video.close': (p) => {
      s.video.close(p.conversationId, p.path);
      return { ok: true };
    },
    'video.write': (p) => s.video.write(p.conversationId, p.path, p.project, p.baseMtimeMs),
    'video.probe': (p) => s.video.probe(p.conversationId, p.paths),
    'video.importFiles': (p) => s.video.importFiles(p.conversationId, p.sourcePaths),
    'video.export': (p) => s.video.startExport(p.conversationId, p.path, p.height, p.wrappedSubtitles),
    'video.exportCancel': (p) => {
      s.video.cancelExport(p.jobId);
      return { ok: true };
    },
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
        throw new Error(hostI18n.t('errors.skills.alreadyExists', { name: p.name }));
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
