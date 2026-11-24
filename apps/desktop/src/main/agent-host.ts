/**
 * agent-host（utilityProcess）的生命周期：fork、注入 env、下发配置、给 renderer 转交 MessagePort、崩溃自动重启。
 */
import { join } from 'node:path';
import {
  app,
  MessageChannelMain,
  session,
  shell,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from 'electron';
import {
  AGENT_PORT_CLOSED_MESSAGE,
  AGENT_PORT_MESSAGE,
  type HostControlMessage,
  type HostTrashRequest,
} from '../shared/desktop';
import { FFMPEG_PATH_ENV, FFPROBE_PATH_ENV, localBuildBinaries, packageBinaries } from '../agent-host/video/ffmpeg-paths';
import { z } from 'zod';
import { appLocale } from './i18n';
import type { DesktopStore } from './store';

const PASS_THROUGH_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL', 'NO_PROXY', 'no_proxy'];
const RESTART_DELAY_MS = 1000;
/** 等 agent-host 确认 config 的上限：超时也放行（最坏是界面随后的请求用的还是旧 Key，报错可重试） */
const CONFIG_ACK_TIMEOUT_MS = 3000;
/** 本机服务（Ollama / LM Studio）不走代理：从 Finder 启动没有 NO_PROXY，localhost 也会被发给代理 */
const LOCAL_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

export class AgentHostManager {
  private child: UtilityProcess | null = null;
  private ready = false;
  private stopping = false;
  private readonly renderers = new Set<WebContents>();
  private configSeq = 0;
  private readonly configAcks = new Map<number, () => void>();

  constructor(
    private readonly store: DesktopStore,
    private readonly userData: string,
  ) {}

  /** 拉起 agent-host；返回的 promise 在 ready 握手完成（配置与端口已下发）后 resolve */
  async start(): Promise<void> {
    this.stopping = false;
    const env = await this.buildEnv();
    const child = utilityProcess.fork(join(__dirname, 'agent-host.js'), [], {
      env,
      serviceName: 'Spark Agent Host',
      stdio: 'inherit',
    });
    this.child = child;
    this.ready = false;
    const ready = new Promise<void>((resolve) => {
      // 握手：agent-host 注册好 parentPort 监听后发 ready，之后再发配置与端口（模块加载要几百毫秒，早发会丢）
      child.on('message', (data: unknown) => {
        if (this.child !== child) return;
        const ack = configAck(data);
        if (ack !== null) {
          this.configAcks.get(ack)?.();
          return;
        }
        const trash = trashRequest.safeParse(data);
        if (trash.success) {
          void this.trash(child, trash.data);
          return;
        }
        if (!isReady(data)) return;
        this.ready = true;
        void this.sendConfig();
        for (const wc of this.renderers) this.connect(wc);
        resolve();
      });
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.notifyPortClosed();
      if (this.stopping) return;
      console.error(`[main] agent-host 退出（code=${code}），${RESTART_DELAY_MS}ms 后重启`);
      setTimeout(() => void this.start(), RESTART_DELAY_MS);
    });
    return ready;
  }

  /** Key 变更后重启，让新 env 生效；resolve 时 renderer 已拿到新端口 */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return Promise.resolve();
    this.ready = false;
    // 先告诉 renderer 端口要失效：之后的请求排队等新端口，而不是发进一个已关闭的端口里石沉大海
    this.notifyPortClosed();
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }

  /**
   * 下发配置（设置、本账号各连接的 Key、旧 Key 迁移出的连接、界面语言）。resolve 于 agent-host 回执
   * config-applied（或超时）；未就绪时直接 resolve，ready 握手后会补发。
   */
  sendConfig(): Promise<void> {
    const child = this.child;
    if (!this.ready || !child) return Promise.resolve();
    const seq = ++this.configSeq;
    const msg: HostControlMessage = {
      type: 'config',
      seq,
      settings: this.store.getSettings(),
      legacyConnections: this.store.migrateLegacyKeys(),
      modelKeys: this.store.modelKeys(),
      locale: appLocale(this.store),
    };
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.configAcks.delete(seq);
        resolve();
      };
      const timer = setTimeout(done, CONFIG_ACK_TIMEOUT_MS);
      this.configAcks.set(seq, done);
      child.postMessage(msg);
    });
  }

  /** 给某个 renderer 建一条直连 agent-host 的 MessagePort（renderer 主动请求 + host 重启后重发） */
  connect(wc: WebContents): void {
    if (!this.renderers.has(wc)) {
      this.renderers.add(wc);
      wc.once('destroyed', () => this.renderers.delete(wc));
    }
    if (!this.child || !this.ready) return; // 未就绪：ready 握手后会统一补发
    const { port1, port2 } = new MessageChannelMain();
    const msg: HostControlMessage = { type: 'port' };
    this.child.postMessage(msg, [port1]);
    wc.postMessage(AGENT_PORT_MESSAGE, null, [port2]);
  }

  /** agent-host 请求把文件移进废纸篓（删会话时它新建的产出）：逐个移，移不动的原样报回去 */
  private async trash(child: UtilityProcess, req: HostTrashRequest): Promise<void> {
    const failed: string[] = [];
    for (const path of req.paths) {
      try {
        await shell.trashItem(path);
      } catch {
        failed.push(path);
      }
    }
    if (this.child !== child) return;
    const msg: HostControlMessage = { type: 'trash-done', id: req.id, failed };
    child.postMessage(msg);
  }

  private notifyPortClosed(): void {
    for (const wc of this.renderers) wc.send(AGENT_PORT_CLOSED_MESSAGE);
  }

  private async buildEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const k of PASS_THROUGH_ENV) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    env.SPARK_USER_DATA = this.userData;
    // 启动期就要用的界面语言（如把上次中断的会话标为失败时写的提示）；之后改语言经 config 消息下发
    env.SPARK_LOCALE = appLocale(this.store);
    // 按账号隔离的数据目录（会话 / 技能 / 连接器）；登录、退出都会重启 agent-host 切过去
    env.SPARK_PROFILE_DIR = this.store.profileDir();
    // 内置技能：打包后随 extraResources 放在 Resources/skills；开发时直接读源码目录
    env.SPARK_BUILTIN_SKILLS = app.isPackaged
      ? join(process.resourcesPath, 'skills')
      : join(app.getAppPath(), 'resources', 'skills');
    // 剪辑器的 ffmpeg / ffprobe：打包后随 extraResources 放在 Resources/ffmpeg；
    // 开发时优先 scripts/build-ffmpeg.sh 的自建产物，没有再用 ffmpeg-static / ffprobe-static 包里的
    const ff = app.isPackaged
      ? { ffmpeg: join(process.resourcesPath, 'ffmpeg', 'ffmpeg'), ffprobe: join(process.resourcesPath, 'ffmpeg', 'ffprobe') }
      : (localBuildBinaries(app.getAppPath()) ?? packageBinaries(join(app.getAppPath(), 'package.json')));
    if (ff) {
      env[FFMPEG_PATH_ENV] = ff.ffmpeg;
      env[FFPROBE_PATH_ENV] = ff.ffprobe;
    }
    env.MCP_TOKEN_ENC_KEY = this.store.mcpEncryptionKey();
    // Web 账号：登录后生图 / 生视频 / 配音经 Web 后端调 aigc（令牌过期 / 未登录就不注入，工具不挂载）
    const webToken = this.store.webToken();
    if (webToken) {
      env.SPARK_WEB_API_URL = this.store.getSettings().webApiUrl;
      env.SPARK_WEB_TOKEN = webToken;
    }
    // 模型 Key 不再经 env：按账号存、经 config 消息下发（改 Key 不用重启）
    const proxy = await resolveProxy();
    if (proxy) {
      env.HTTPS_PROXY = proxy;
      env.HTTP_PROXY = proxy;
    }
    const noProxy = new Set([...(env.NO_PROXY ?? env.no_proxy ?? '').split(','), ...LOCAL_NO_PROXY].filter(Boolean));
    env.NO_PROXY = [...noProxy].join(',');
    env.no_proxy = env.NO_PROXY;
    return env;
  }
}

/** agent-host 处理完 config 的回执：返回序号；不是回执返回 null */
function configAck(data: unknown): number | null {
  return typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'config-applied' &&
    'seq' in data &&
    typeof data.seq === 'number'
    ? data.seq
    : null;
}

const trashRequest = z.object({ type: z.literal('trash'), id: z.number(), paths: z.array(z.string()) });

function isReady(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'ready';
}

/**
 * 代理：终端启动时沿用 HTTPS_PROXY；从 Finder 启动没有这个变量，就问 Chromium 的系统代理设置。
 * 只认 HTTP(S) 代理（Node 的 EnvHttpProxyAgent 不支持 SOCKS）。
 */
async function resolveProxy(): Promise<string | null> {
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
  if (fromEnv) return fromEnv;
  try {
    const rule = await session.defaultSession.resolveProxy('https://generativelanguage.googleapis.com');
    const m = /(?:PROXY|HTTPS)\s+([^;\s]+)/.exec(rule);
    return m ? `http://${m[1]}` : null;
  } catch {
    return null;
  }
}
