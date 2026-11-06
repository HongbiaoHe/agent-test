/**
 * agent-host 入口（Electron utilityProcess）：持有 SQLite、checkpointer、RunService、技能库、MCP。
 *
 * - main 经 parentPort 发 `config`（设置 + Key 状态）与 `port`（转交给 renderer 的 MessagePort）；
 * - 模型 Key / MCP 加密密钥 / 代理 / userData 目录都经 env 在 fork 时注入，改 Key 时 main 会重启本进程；
 * - 启动时把上次没跑完（status=running）的会话标成失败并追加「运行中断」消息（崩溃 / 强退的收尾）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MessagePortMain } from 'electron';
import { z } from 'zod';
import type { HostControlMessage } from '../shared/desktop';
import { LANGUAGE_PREFERENCES, LOCALES } from '../shared/i18n/locales';
import { type HostEvent, isMethod, type RpcResponse } from '../shared/rpc';
import { NodeSqliteSaver } from './db/checkpointer';
import { ConversationRepo } from './db/conversations';
import { openDatabase } from './db/database';
import { McpStore } from './mcp/mcp-store';
import { createOAuthCallbackServer, OAUTH_REDIRECT_URI } from './mcp/oauth-callback';
import { installEnvProxy } from './proxy';
import { BackgroundService } from './background/background-service';
import { setHostLocale } from './i18n';
import { createHandlers, dispatch } from './rpc-server';
import { RunService } from './run/run-service';
import { SkillStore } from './skills/skill-store';
import { WebApi } from './web-media/web-api';
import { ProcessTracker } from './workspace/process-tracker';

const log = (msg: string) => console.log(`[agent-host] ${msg}`);

const startupLocale = z.enum(LOCALES).safeParse(process.env.SPARK_LOCALE);
if (startupLocale.success) setHostLocale(startupLocale.data);

const userData = process.env.SPARK_USER_DATA;
if (!userData) throw new Error('SPARK_USER_DATA 未设置（应由 main 进程注入）');
// 当前账号的数据目录（会话 / 技能 / 连接器按用户隔离；访客 = userData 本身），见 main/store.ts profileDir
const profileDir = process.env.SPARK_PROFILE_DIR ?? userData;
mkdirSync(profileDir, { recursive: true });
if (installEnvProxy()) log('已启用环境代理');
log(`数据目录：${profileDir === userData ? '访客空间' : profileDir}`);

const db = openDatabase(join(profileDir, 'spark.db'));
// 默认工作区来自 main 发来的配置；配置到达前不会有 renderer 请求（端口在配置之后才发）
const repo = new ConversationRepo(db, () => current?.settings.workspaceDir ?? '');
const interrupted = repo.failInterrupted();
if (interrupted.length) log(`上次未完成的会话已标为失败：${interrupted.join(', ')}`);
// 命令进程登记表是设备级（device.db）：A 账号崩溃留下的孤儿进程，切到 B 账号启动时也要清掉
const processes = new ProcessTracker(openDatabase(join(userData, 'device.db')));
// 早期版本把登记表放在访客库里：顺手清一次，之后不再写
new ProcessTracker(db).reapOrphans();
const reaped = processes.reapOrphans();
if (reaped) log(`清理了上次残留的命令进程组：${reaped} 个`);
const checkpointer = new NodeSqliteSaver(db);
const skills = new SkillStore(db, join(profileDir, 'skills'), process.env.SPARK_BUILTIN_SKILLS ?? null);

const ports = new Set<MessagePortMain>();
function broadcast(event: HostEvent): void {
  // 事件 payload 来自 LangChain（可能含类实例）：JSON 往返一次，保证可结构化克隆
  const data: unknown = JSON.parse(JSON.stringify(event));
  for (const p of ports) p.postMessage(data);
}
const listChanged = () => broadcast({ kind: 'event', type: 'conversations-changed' });
const mcpChanged = () => broadcast({ kind: 'event', type: 'mcp-changed' });
const skillsChanged = () => broadcast({ kind: 'event', type: 'skills-changed' });

const settingsSchema = z.object({
  workspaceDir: z.string(),
  defaultModel: z.string(),
  webApiUrl: z.string(),
  loginSkipped: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  language: z.enum(LANGUAGE_PREFERENCES),
});
const controlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('config'),
    settings: settingsSchema,
    keys: z.object({ google: z.boolean(), deepseek: z.boolean() }),
    locale: z.enum(LOCALES),
  }),
  z.object({ type: z.literal('port') }),
]);

let current: Extract<HostControlMessage, { type: 'config' }> | null = null;
const runtimeRoot = join(profileDir, 'runtime');
function config() {
  if (!current) throw new Error('agent-host 尚未收到配置');
  const { settings, keys } = current;
  return {
    workspaceDir: settings.workspaceDir,
    defaultModel: settings.defaultModel,
    runtimeRoot,
    keys,
  };
}

// 回调服务懒启动：McpStore 第一次遇到需要授权时才调 ensureCallbackServer（届时下面的 const 早已初始化）
const mcp: McpStore = new McpStore(db, OAUTH_REDIRECT_URI, () => ensureCallbackServer());
const ensureCallbackServer = createOAuthCallbackServer(
  async (code, state) => {
    const server = await mcp.completeOAuth(code, state);
    mcpChanged();
    broadcast({ kind: 'event', type: 'mcp-oauth', ok: true, serverId: server.id });
    return server.name;
  },
  (error) => {
    mcpChanged();
    broadcast({ kind: 'event', type: 'mcp-oauth', ok: false, error });
  },
);
// 重启前发起、还没回调的授权：重新监听 loopback 端口，用户在浏览器里完成授权仍然有效
if (mcp.hasPendingAuth()) {
  ensureCallbackServer().catch((e: unknown) => log(`OAuth 回调服务启动失败：${String(e)}`));
}

// Web 账号（main 在登录后经 env 注入令牌）：有就挂载生图 / 生视频 / 配音
const webApi = WebApi.fromEnv();
if (webApi) log(`已登录 Web 账号，媒体生成经 ${webApi.baseUrl}`);

const runs = new RunService({
  webApi,
  repo,
  checkpointer,
  skills,
  mcp,
  processes,
  config,
  skillsChanged,
  emit: (conversationId, event) =>
    broadcast({
      kind: 'event',
      type: 'conversation',
      conversationId,
      event: { ...event, ts: Date.now() },
    }),
  listChanged,
  log,
});

const background = new BackgroundService({
  db,
  repo,
  callTool: (serverId, name, args) => mcp.callTool(serverId, name, args),
  processes,
  emit: (conversationId, event) =>
    broadcast({ kind: 'event', type: 'conversation', conversationId, event: { ...event, ts: Date.now() } }),
  startTurn: (conversationId) => runs.runClaimed(conversationId),
  listChanged,
  log,
});
runs.setBackground(background);
// 恢复上次没结束的后台任务（命令已被 reapOrphans 清掉 → 标中断并通知；watch / wakeup 接着计时）
try {
  background.resume();
} catch (e) {
  log(`恢复后台任务失败：${String(e)}`);
}

const handlers = createHandlers({
  background,
  webApi,
  repo,
  runs,
  skills,
  mcp,
  config,
  listChanged,
  mcpChanged,
  skillsChanged,
});

const requestSchema = z.object({
  kind: z.literal('request'),
  id: z.number(),
  method: z.string(),
  params: z.unknown(),
});

function attach(port: MessagePortMain): void {
  ports.add(port);
  port.on('message', (e) => {
    const req = requestSchema.safeParse(e.data);
    if (!req.success) return;
    const { id, method, params } = req.data;
    const reply = (res: RpcResponse) => port.postMessage(res);
    if (!isMethod(method)) {
      reply({ kind: 'response', id, ok: false, error: `未知方法：${method}` });
      return;
    }
    dispatch(handlers, method, params).then(
      (result) => reply({ kind: 'response', id, ok: true, result: JSON.parse(JSON.stringify(result)) as unknown }),
      (err: unknown) => {
        const error = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err);
        log(`${method} 失败：${error}`);
        reply({ kind: 'response', id, ok: false, error });
      },
    );
  });
  port.on('close', () => ports.delete(port));
  port.start();
}

process.parentPort.on('message', (e) => {
  const msg = controlSchema.safeParse(e.data);
  if (!msg.success) return;
  if (msg.data.type === 'config') {
    current = msg.data;
    setHostLocale(msg.data.locale);
    return;
  }
  const port = e.ports[0];
  if (port) attach(port);
});

// 握手：监听已注册，通知 main 可以发配置与端口了
process.parentPort.postMessage({ type: 'ready' });
log('ready');
