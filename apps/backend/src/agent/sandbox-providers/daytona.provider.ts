/**
 * Daytona 沙箱提供方（SANDBOX_PROVIDER=daytona，缺省）。逻辑自 sandbox.ts 原样迁出。
 */

import { Daytona, type Sandbox } from '@daytonaio/sdk';
import { DaytonaSandbox } from '@langchain/daytona';
import {
  egressSignature,
  type SandboxNetwork,
  SandboxNetworkUnsupportedError,
  toDaytonaEgress,
} from './network';
import type {
  ConnectedSandbox,
  SandboxLifecycle,
  SandboxListing,
  SandboxProvider,
} from './types';

// ─── 验证过的 API 事实 ─────────────────────────────────────────────
// @daytonaio/sdk 0.185.0 Daytona.d.ts:
//   · list(query?: ListSandboxesQuery): AsyncIterableIterator<Sandbox>   — 无 findOne
//   · ListSandboxesQuery.labels?: Record<string,string>                  — 按标签过滤
// @daytonaio/sdk Sandbox.d.ts:
//   · state?: SandboxState  （字符串常量枚举，"started"/"stopped" 等）    — 无 isRunning
// @langchain/daytona 0.2.0 index.d.ts:
//   · DaytonaSandbox.create(options?)                                     — 静态工厂
//   · DaytonaSandbox.fromId(id, options?)                                 — 静态，按 SDK sandbox.id 连接
//   · DaytonaSandbox.isRunning: boolean — ⚠️ 只表示「实例已初始化」（#sandbox !== null），
//     fromId 之后恒为 true，与沙箱真实运行状态无关（dist/index.js:254）。
//     判断是否需要 start() 必须用 SDK list() 返回的 sandbox.state === 'started'。
//   · DaytonaSandbox.start(timeout?)                                      — 实例方法，委托 SDK start 并等待 started
//   · DaytonaSandboxOptions.autoStopInterval / autoArchiveInterval / autoDeleteInterval — 单位：分钟
// ──────────────────────────────────────────────────────────────────

/** noVNC web 客户端端口（computerUse.start 拉起的 novnc 进程监听 6080） */
const DESKTOP_PORT = 6080;
/** 签名预览 URL 有效期（秒）：单次 Dialog 会话足够，重开重签 */
const DESKTOP_URL_TTL_S = 3600;

/**
 * 下发出站策略。Tier 1/2 组织不允许沙箱级覆盖（API 报 "cannot be overridden at the sandbox level"），
 * 转成 SandboxNetworkUnsupportedError，由上层回滚设置并提示（而不是当成偶发失败重试）。
 */
async function updateEgress(
  sandboxId: string,
  network: SandboxNetwork,
): Promise<void> {
  try {
    await (
      await new Daytona().get(sandboxId)
    ).updateNetworkSettings(toDaytonaEgress(network));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('cannot be overridden at the sandbox level')) {
      throw new SandboxNetworkUnsupportedError(msg);
    }
    throw e;
  }
}

async function withHome(sb: DaytonaSandbox): Promise<ConnectedSandbox> {
  return { inner: sb, homeDir: await sb.getWorkDir() };
}

/**
 * 远端生命周期与设置不一致时更新（SDK Sandbox.setAutostopInterval / setAutoDeleteInterval，
 * 单位分钟；autoDelete 负值 = 禁用）。listing 字段来自 list()，一致则不发请求。
 */
async function syncLifecycle(
  // 只取这两个方法：@langchain/daytona 内嵌的 SDK 版本（0.155）与直接依赖（0.185）的
  // Sandbox 类型不完全兼容，但这两个方法签名一致
  sb: Pick<Sandbox, 'setAutostopInterval' | 'setAutoDeleteInterval'>,
  listing: SandboxListing,
  lifecycle: SandboxLifecycle,
): Promise<void> {
  if (listing.autoStopInterval !== lifecycle.idleMinutes) {
    await sb.setAutostopInterval(lifecycle.idleMinutes);
  }
  if (listing.autoDeleteInterval !== lifecycle.autoDeleteMinutes) {
    await sb.setAutoDeleteInterval(lifecycle.autoDeleteMinutes);
  }
}

export const daytonaProvider: SandboxProvider = {
  name: 'daytona',
  supportsAutoDelete: true,
  /**
   * 沙箱级出站策略取决于 Daytona 账户等级：Tier 1/2 组织级策略优先、API 直接拒绝
   * （2026-10-14 实测本账户如此，只放行 PyPI / npm / GitHub 等常用服务）；Tier 3/4 才能按沙箱设置。
   * 默认关闭，Tier 3+ 账户设 env DAYTONA_NETWORK_CONTROL=1 打开。
   */
  get supportsEgressControl(): boolean {
    const v = process.env.DAYTONA_NETWORK_CONTROL?.trim().toLowerCase();
    return v === '1' || v === 'true';
  },
  // networkAllowList 只收 CIDR（SDK 类型注释）
  supportsDomainAllowList: false,
  // 预览链接在 public 未设为 true 时需令牌；我们从不设 public，入站始终私有
  supportsPublicTrafficToggle: false,

  isConfigured: () => !!process.env.DAYTONA_API_KEY,

  async listUserSandboxes(userId: string): Promise<SandboxListing[]> {
    const client = new Daytona();
    const all: SandboxListing[] = [];
    for await (const s of client.list({ labels: { user_id: userId } })) {
      const allow = s.networkAllowList
        ? s.networkAllowList.split(',').filter(Boolean)
        : [];
      all.push({
        id: s.id,
        state: s.state,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        autoStopInterval: s.autoStopInterval,
        autoDeleteInterval: s.autoDeleteInterval,
        // 有白名单 = 其余全拒；networkBlockAll = 全拒
        egress: egressSignature({
          blockAll: !!s.networkBlockAll || allow.length > 0,
          allow,
        }),
        publicTraffic: s.public,
      });
    }
    return all;
  },

  async connect(
    listing: SandboxListing,
    lifecycle: SandboxLifecycle,
  ): Promise<ConnectedSandbox> {
    // 用 LangChain wrapper 连接，以便 execute/upload 等高级方法可用
    const sb = await DaytonaSandbox.fromId(listing.id);
    // ⚠️ 不能用 sb.isRunning 判断（fromId 后恒为 true，见上方 API 事实），
    // 须用 list() 返回的 state；非 started（stopped/starting 等）都走 start()
    // 等待就绪（停机沙箱不拉起，后续 getWorkDir/execute 会 400 "no IP address found"）。
    if (listing.state !== 'started') {
      await sb.start();
    }
    await syncLifecycle(sb.instance, listing, lifecycle);
    return withHome(sb);
  },

  async create(
    userId: string,
    lifecycle: SandboxLifecycle,
    network: SandboxNetwork,
  ): Promise<ConnectedSandbox> {
    // auto*Interval 单位：分钟（已验证；delete 从停机时刻起算）。
    // 不配置 autoArchiveInterval：停机直接等删除，无归档中间态。
    const sb = await DaytonaSandbox.create({
      labels: { user_id: userId },
      autoStopInterval: lifecycle.idleMinutes, // 闲置自动停机，停机态只计存储费用
      autoDeleteInterval: lifecycle.autoDeleteMinutes, // 停机后自动删除（-1 = 不删）
    });
    // @langchain/daytona 的 create 不透传网络参数，建好后立即补设（运行中生效）
    if (network.egress !== 'open') await updateEgress(sb.id, network);
    return withHome(sb);
  },

  desiredEgress(network: SandboxNetwork): string {
    const d = toDaytonaEgress(network);
    const allow = d.networkAllowList?.split(',') ?? [];
    return egressSignature({
      blockAll: d.networkBlockAll || allow.length > 0,
      allow,
    });
  },

  async applyEgress(
    listing: SandboxListing,
    network: SandboxNetwork,
  ): Promise<void> {
    await updateEgress(listing.id, network);
  },

  inspectPublicTraffic(listing: SandboxListing): Promise<boolean> {
    // list 结果自带 public 字段
    return Promise.resolve(listing.publicTraffic ?? false);
  },

  async applyLifecycle(
    listing: SandboxListing,
    lifecycle: SandboxLifecycle,
  ): Promise<void> {
    // 只改远端配置，不 start（停机沙箱保持停机）
    await syncLifecycle(
      await new Daytona().get(listing.id),
      listing,
      lifecycle,
    );
  },

  /**
   * 标准预览链接 `https://{port}-{sandboxId}.{proxyDomain}` + 私有令牌头（官方文档：
   * x-daytona-preview-token）。不用签名地址：签名地址默认 60s 过期且令牌在域名里，反代要的是
   * 长期可用的上游；顺带用 X-Daytona-Skip-Preview-Warning 跳过浏览器首访的警告拦截页。
   * getPreviewLink 在端口未开放时会自动开放（SDK 注释）。
   */
  async portUpstream(sandboxId: string, port: number) {
    const sb = await new Daytona().get(sandboxId);
    const link = await sb.getPreviewLink(port);
    return {
      origin: new URL(link.url).origin,
      headers: {
        'x-daytona-preview-token': link.token,
        'X-Daytona-Skip-Preview-Warning': 'true',
      },
    };
  },

  /**
   * Daytona 按「最后活跃时间 + 闲置间隔」自动停机；SDK 的 refreshActivity 正是为
   * 「用户还在用、但沙箱里没有 API 活动」准备的（SDK 注释）。闲置间隔已由 lifecycle 配在沙箱上。
   */
  async keepAlive(sandboxId: string) {
    await (await new Daytona().get(sandboxId)).refreshActivity();
  },

  desktop: {
    /**
     * GuardedSandbox 不暴露 computerUse/getSignedPreviewUrl，须走 SDK 原生对象（client.get(id)）。
     * computerUse.start() 幂等：已 active 时秒回（实测拉起 Xvfb/XFCE/x11vnc/noVNC 约 3-5s）。
     *
     * ⚠️ stop→start 循环自愈（2026-07-25 实测 Daytona 缺陷）：computerUse.stop() 后再
     * start() 会报 `failed to start: [novnc]`——start 按序拉起四进程，卡在 novnc（supervisor
     * 状态残留），此时其余进程其实已在运行。恢复手段是对未运行进程逐个 restartProcess()
     * （实测一次即全绿）。故 start 失败不直接抛：先探测补救，补救仍失败才抛原错误。
     */
    async start(sandboxId: string): Promise<string> {
      const sb = await new Daytona().get(sandboxId);
      try {
        await sb.computerUse.start();
      } catch (startErr) {
        // 自愈路径：把没跑起来的桌面进程逐个 restart；任何一步失败都抛回 start 的原错误
        // （比 restart 的错误更能说明根因），由前端「重试」按钮兜底。
        try {
          for (const name of ['xvfb', 'xfce4', 'x11vnc', 'novnc']) {
            const st = await sb.computerUse.getProcessStatus(name);
            if (!st.running) await sb.computerUse.restartProcess(name);
          }
        } catch {
          throw startErr;
        }
      }
      const signed = await sb.getSignedPreviewUrl(
        DESKTOP_PORT,
        DESKTOP_URL_TTL_S,
      );
      return `${signed.url}/vnc.html?autoconnect=true&resize=scale`;
    },

    async stop(sandboxId: string): Promise<void> {
      const sb = await new Daytona().get(sandboxId);
      await sb.computerUse.stop();
    },
  },
};
