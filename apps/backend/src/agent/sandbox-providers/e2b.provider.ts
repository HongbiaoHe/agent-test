/**
 * E2B 沙箱提供方（SANDBOX_PROVIDER=e2b）。凭据：E2B_API_KEY（SDK 自动读取该环境变量）。
 *
 * 生命周期（闲置时长由用户在 /settings/sandbox 配置，缺省 5 分钟）：
 *  - 创建时 timeoutMs=闲置时长 + lifecycle.onTimeout='pause'：到期自动暂停而非销毁；
 *    E2BSandbox 每次操作前续期，所以「到期」= 最后一次操作后闲置满该时长。
 *  - 暂停态保留文件系统与内存，且**永久保留、不自动删除**（docs.e2b.dev/sandbox/persistence）
 *    ——与 Daytona「停机 10 分钟后删除」不同，状态接口对应返回 autoDeleteInterval 缺省。
 *  - Sandbox.connect 会自动恢复暂停态（实测恢复 ~0.6s，暂停前写入的文件仍在）。
 *  - autoResume=false：不让外部流量唤醒，只有我们显式 connect 才恢复。
 *  - Sandbox.list 不续期（实测每 10s 轮询 list，20s 超时照常暂停）——状态心跳安全。
 *
 * 网络（用户在 /settings/sandbox 配置）：出站 allowOut/denyOut 创建时设定、运行中 updateNetwork
 * 整体替换；入站 allowPublicTraffic 只能创建时设定（默认公网地址任何人可访问，我们默认关闭）。
 *
 * 不支持图形桌面（需专用 desktop 模板），故不提供 desktop 字段。
 */

import { Sandbox, type SandboxInfo } from 'e2b';
import { E2BSandbox } from './e2b-sandbox';
import { egressSignature, type SandboxNetwork, toE2bEgress } from './network';
import type {
  ConnectedSandbox,
  SandboxLifecycle,
  SandboxListing,
  SandboxProvider,
} from './types';

const idleMs = (lifecycle: SandboxLifecycle) => lifecycle.idleMinutes * 60_000;
/** base 模板默认用户 `user` 的 home（实测 $HOME=/home/user、whoami=user）。 */
const E2B_HOME = '/home/user';

/** E2B SandboxInfo → 统一 listing（state 映射到 Daytona 口径，见 types.ts）。 */
export function toListing(info: SandboxInfo): SandboxListing {
  return {
    id: info.sandboxId,
    // SandboxState 只有 'running' | 'paused' 两态
    state: info.state === 'running' ? 'started' : 'stopped',
    createdAt: info.startedAt.toISOString(),
    // 不带 egress / publicTraffic：Sandbox.list 的结果不含网络信息（2026-10-14 实测只有
    // getInfo 才有），缺省即「未知」——出站按需要同步处理，入站由 inspectPublicTraffic 现查
    // 闲置时长不在 SandboxInfo 里（E2B 只有绝对到期时间 endAt），状态接口回退用用户设置
  };
}

function wrap(sbx: Sandbox, lifecycle: SandboxLifecycle): ConnectedSandbox {
  return { inner: new E2BSandbox(sbx, idleMs(lifecycle)), homeDir: E2B_HOME };
}

export const e2bProvider: SandboxProvider = {
  name: 'e2b',
  // 暂停态永久保留，无「停机后删除」
  supportsAutoDelete: false,
  supportsEgressControl: true,
  supportsDomainAllowList: true,
  supportsPublicTrafficToggle: true,

  isConfigured: () => !!process.env.E2B_API_KEY,

  async listUserSandboxes(userId: string): Promise<SandboxListing[]> {
    // 缺省 state 过滤即 ['running','paused']，分页取全
    const paginator = Sandbox.list({
      query: { metadata: { user_id: userId } },
    });
    const all: SandboxListing[] = [];
    while (paginator.hasNext) {
      for (const info of await paginator.nextItems()) all.push(toListing(info));
    }
    return all;
  },

  async connect(
    listing: SandboxListing,
    lifecycle: SandboxLifecycle,
  ): Promise<ConnectedSandbox> {
    // 暂停态会被自动恢复；运行态则把到期时间延长到至少 now+闲置时长
    // （调短闲置时长由 applyLifecycle 在保存设置时立即生效）
    const sbx = await Sandbox.connect(listing.id, {
      timeoutMs: idleMs(lifecycle),
    });
    return wrap(sbx, lifecycle);
  },

  async create(
    userId: string,
    lifecycle: SandboxLifecycle,
    network: SandboxNetwork,
  ): Promise<ConnectedSandbox> {
    const sbx = await Sandbox.create({
      metadata: { user_id: userId },
      timeoutMs: idleMs(lifecycle),
      lifecycle: { onTimeout: 'pause', autoResume: false },
      network: {
        ...toE2bEgress(network),
        allowPublicTraffic: network.publicTraffic,
      },
    });
    return wrap(sbx, lifecycle);
  },

  desiredEgress(network: SandboxNetwork): string {
    const e = toE2bEgress(network);
    return egressSignature({ blockAll: !!e.denyOut, allow: e.allowOut ?? [] });
  },

  async applyEgress(
    listing: SandboxListing,
    network: SandboxNetwork,
  ): Promise<void> {
    // 整体替换（不合并）：open 传空对象即清空全部规则（实测 updateNetwork({}) 立即恢复联网）
    await Sandbox.updateNetwork(listing.id, toE2bEgress(network));
  },

  async inspectPublicTraffic(listing: SandboxListing): Promise<boolean> {
    const info = await Sandbox.getInfo(listing.id);
    // allowPublicTraffic 缺省 = E2B 默认公开
    return info.network?.allowPublicTraffic ?? true;
  },

  async applyLifecycle(
    listing: SandboxListing,
    lifecycle: SandboxLifecycle,
  ): Promise<void> {
    // 运行中：到期时间重设为「现在 + 新闲置时长」；暂停中：不唤醒，下次恢复时按新设置
    if (listing.state === 'started') {
      await Sandbox.setTimeout(listing.id, idleMs(lifecycle));
    }
  },
};
