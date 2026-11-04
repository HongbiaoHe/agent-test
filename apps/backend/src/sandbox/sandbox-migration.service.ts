import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { SandboxMigration } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  AGENT_WORKSPACE_DIR,
  findUserSandbox,
  pickUserSandbox,
} from '../agent/sandbox';
import {
  getSandboxProvider,
  type SandboxLifecycle,
  type SandboxNetwork,
  type SandboxProvider,
} from '../agent/sandbox-providers';
import {
  isSandboxSizeId,
  type SandboxSizeId,
} from '../agent/sandbox-providers/sizes';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import {
  cleanupArchiveScript,
  type InventoryEntry,
  isSafeRelPath,
  listDirScript,
  MIGRATION_ARCHIVE,
  type MigrationExcludes,
  NO_EXCLUDES,
  normalizeExcludes,
  packScript,
  parseListDir,
  parseRootExtras,
  parseStats,
  pullScript,
  rootExtrasScript,
  statsScript,
} from './sandbox-migration.util';
import { SandboxSettingsService } from './sandbox-settings.service';

export const SANDBOX_MIGRATE_QUEUE = 'sandbox-migrate';

export interface SandboxMigrateJob {
  migrationId: string;
  /** 用户在盘点时选的排除项（只随任务走，不落库） */
  excludes?: MigrationExcludes;
}

/** GET /sandbox/inventory：某一层目录的占用；根目录额外带依赖目录、按类型汇总与总量 */
export interface SandboxInventory {
  path: string;
  entries: InventoryEntry[];
  truncated: { count: number; bytes: number } | null;
  root?: ReturnType<typeof parseRootExtras>;
}

export type MigrationPhase =
  | 'prepare'
  | 'pack'
  | 'create'
  | 'transfer'
  | 'verify'
  | 'switch'
  | 'cleanup'
  | 'done';

/** 前端展示用（BigInt 转 number：工作区不会大到超出安全整数） */
export interface MigrationView {
  id: string;
  fromSize: string;
  toSize: string;
  status: 'running' | 'done' | 'failed';
  phase: string;
  message: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 迁移期间两台沙箱的到期时间：足够跑完打包 + 传输（几 GB 也够），结束后调回用户的闲置设置 */
const MIGRATION_IDLE_MINUTES = 60;
/** 单条迁移命令（打包 / 拉取解包）的上限 */
const RUN_TIMEOUT_MS = 50 * 60_000;
/** running 超过这么久没有任何进展（updatedAt 不动）= 进程中途被杀，按失败处理（要大于单步上限） */
const STALE_MS = 90 * 60_000;
/** 会占用沙箱的会话状态：这些状态下换档会让 agent 跑到一半沙箱被换掉 */
const ACTIVE_CONVERSATION = ['queued', 'running', 'waiting_approval'];

/**
 * 沙箱换档迁移（只支持 provider.supportsSizes，目前即 E2B：规格由模板决定，不能原地扩容）。
 *
 * 流程：旧沙箱打包工作区（按用户在盘点时选的排除项）→ 用新档模板建新沙箱 → 新沙箱 curl 旧沙箱的下载直链、
 * 边下边解包（文件只在两台沙箱之间走，不经后端）→ 复核文件数与总字节数 → 套上用户的出站设置
 * → 用户档位切到新档 → 删除旧沙箱。
 * 切换前任何一步失败：删掉新沙箱、保留旧沙箱，用户档位不变（下次运行照旧用旧沙箱）。
 * 新旧沙箱迁移期间并存；pickUserSandbox 按档位优先选，所以切换前读写都落在旧沙箱。
 */
@Injectable()
export class SandboxMigrationService {
  private readonly logger = new Logger(SandboxMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SandboxSettingsService,
    @InjectQueue(SANDBOX_MIGRATE_QUEUE)
    private readonly queue: Queue<SandboxMigrateJob>,
  ) {}

  async start(
    userId: string,
    toSize: string,
    rawExcludes?: unknown,
  ): Promise<MigrationView> {
    const excludes = normalizeExcludes(rawExcludes);
    if (!excludes) {
      throw new BusinessException(ErrorCodes.SANDBOX_EXCLUDES_INVALID);
    }
    const cfg = await this.settings.resolve(userId);
    const provider = getSandboxProvider(cfg.provider);
    if (!provider.supportsSizes || !provider.migration) {
      throw new BusinessException(ErrorCodes.SANDBOX_SIZE_UNSUPPORTED);
    }
    if (!isSandboxSizeId(toSize) || toSize === cfg.size) {
      throw new BusinessException(ErrorCodes.SANDBOX_SIZE_INVALID);
    }
    if (await this.running(userId)) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_MIGRATING,
        HttpStatus.CONFLICT,
      );
    }
    const [convs, tasks] = await Promise.all([
      this.prisma.conversation.count({
        where: {
          userId,
          deletedAt: null,
          status: { in: ACTIVE_CONVERSATION },
        },
      }),
      this.prisma.backgroundTask.count({
        where: { userId, status: 'running' },
      }),
    ]);
    if (convs > 0 || tasks > 0) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_MIGRATION_BLOCKED,
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.prisma.sandboxMigration.create({
      data: {
        userId,
        provider: provider.name,
        fromSize: cfg.size,
        toSize,
      },
    });
    await this.queue.add(
      'migrate',
      { migrationId: row.id, excludes },
      { jobId: row.id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    );
    return toView(row);
  }

  /**
   * 盘点工作区某一层（迁移前让用户看占用、挑排除项）。会唤醒暂停的沙箱。
   * 根目录（path 为空）额外返回依赖目录（默认建议排除）、按扩展名汇总与总量。
   */
  async inventory(userId: string, path: string): Promise<SandboxInventory> {
    const rel = path.replace(/^\.\//, '').replace(/\/+$/, '');
    if (rel && !isSafeRelPath(rel)) {
      throw new BusinessException(ErrorCodes.SANDBOX_EXCLUDES_INVALID);
    }
    const sb = await this.workspace(userId);
    const listed = await sb.execute(listDirScript(rel));
    if (listed.exitCode === 3) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    const result: SandboxInventory = {
      path: rel,
      ...parseListDir(listed.output),
    };
    if (!rel) {
      result.root = parseRootExtras(
        (await sb.execute(rootExtrasScript())).output,
      );
    }
    return result;
  }

  /** 按排除项精确统计将迁移的文件数与总大小（与迁移时的统计同一口径）。 */
  async estimate(
    userId: string,
    rawExcludes: unknown,
  ): Promise<{ files: number; bytes: number }> {
    const excludes = normalizeExcludes(rawExcludes);
    if (!excludes) {
      throw new BusinessException(ErrorCodes.SANDBOX_EXCLUDES_INVALID);
    }
    const sb = await this.workspace(userId);
    return parseStats((await sb.execute(statsScript(excludes))).output);
  }

  /** 用户当前沙箱的工作区（GuardedSandbox：命令在工作区根目录下执行）；没有沙箱或连不上 → 409。 */
  private async workspace(userId: string) {
    const cfg = await this.settings.resolve(userId);
    const sb = await findUserSandbox(userId, cfg);
    if (!sb) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_INVENTORY_UNAVAILABLE,
        HttpStatus.CONFLICT,
      );
    }
    return sb;
  }

  /** 最近一次迁移（设置页轮询用）；没迁移过返回 null。 */
  async latest(userId: string): Promise<MigrationView | null> {
    const row = await this.prisma.sandboxMigration.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    return toView(await this.failIfStale(row));
  }

  /** 迁移中则拒绝（会话发消息 / 新建会话前调用）：迁移期间新的运行会写进即将被替换的旧沙箱。 */
  async assertNotMigrating(userId: string): Promise<void> {
    if (await this.running(userId)) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_MIGRATING,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async running(userId: string): Promise<boolean> {
    const row = await this.prisma.sandboxMigration.findFirst({
      where: { userId, status: 'running' },
      orderBy: { createdAt: 'desc' },
    });
    return !!row && (await this.failIfStale(row)).status === 'running';
  }

  private async failIfStale(row: SandboxMigration): Promise<SandboxMigration> {
    if (
      row.status !== 'running' ||
      Date.now() - row.updatedAt.getTime() < STALE_MS
    ) {
      return row;
    }
    return this.prisma.sandboxMigration.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        message: '迁移中断（服务重启或超时），旧沙箱与原配置保持不变',
        finishedAt: new Date(),
      },
    });
  }

  /** processor 调用：执行一次迁移。不抛错——失败写进记录。 */
  async run(
    migrationId: string,
    excludes: MigrationExcludes = NO_EXCLUDES,
  ): Promise<void> {
    const m = await this.prisma.sandboxMigration.findUnique({
      where: { id: migrationId },
    });
    if (!m || m.status !== 'running') return;
    const cfg = await this.settings.resolve(m.userId);
    const provider = getSandboxProvider(cfg.provider);
    const ops = provider.migration;
    const toSize = m.toSize;
    if (!ops || !isSandboxSizeId(toSize) || !isSandboxSizeId(m.fromSize)) {
      await this.finish(m.id, 'failed', '当前提供方不支持换档');
      return;
    }
    const migrating: SandboxLifecycle = {
      ...cfg.lifecycle,
      idleMinutes: MIGRATION_IDLE_MINUTES,
    };
    let oldId: string | null = null;
    let newId: string | null = null;
    let switched = false;
    try {
      await this.phase(m.id, 'prepare');
      const old = await pickUserSandbox(m.userId, provider.name, m.fromSize);
      if (!old) {
        // 还没有沙箱：没有文件可搬，直接切档，下次运行按新档创建
        await this.switchSize(m.userId, toSize);
        await this.finish(m.id, 'done', '还没有沙箱，下次运行时会按新配置创建');
        return;
      }
      oldId = old.id;
      await this.prisma.sandboxMigration.update({
        where: { id: m.id },
        data: { oldSandboxId: oldId },
      });

      await this.phase(m.id, 'pack');
      // connect 顺带唤醒暂停的旧沙箱，并把到期时间拉长到迁移时长
      const oldConn = await provider.connect(old, migrating);
      const ws = `${oldConn.homeDir}/${AGENT_WORKSPACE_DIR}`;
      const packed = await this.pack(ops, oldId, ws, excludes);
      await this.prisma.sandboxMigration.update({
        where: { id: m.id },
        data: {
          fileCount: packed.stats.files,
          totalBytes: BigInt(packed.stats.bytes),
        },
      });

      await this.phase(m.id, 'create');
      // 先放开出站：新沙箱要 curl 旧沙箱的下载直链。校验通过后再套用户的出站设置
      const newConn = await provider.create(
        m.userId,
        migrating,
        { ...cfg.network, egress: 'open' },
        toSize,
      );
      newId = newConn.inner.id;
      await this.prisma.sandboxMigration.update({
        where: { id: m.id },
        data: { newSandboxId: newId },
      });

      if (packed.archived) {
        await this.phase(m.id, 'transfer');
        const newWs = `${newConn.homeDir}/${AGENT_WORKSPACE_DIR}`;
        const res = await ops.run(
          newId,
          pullScript(
            newWs,
            await ops.downloadUrl(oldId, MIGRATION_ARCHIVE),
            excludes,
          ),
          RUN_TIMEOUT_MS,
        );
        if (res.exitCode !== 0) {
          throw new Error(`传输或解包失败：${res.output.slice(-300)}`);
        }

        await this.phase(m.id, 'verify');
        const got = parseStats(res.output);
        if (
          got.files !== packed.stats.files ||
          got.bytes !== packed.stats.bytes
        ) {
          throw new Error(
            `校验不一致：旧沙箱 ${packed.stats.files} 个文件 / ${packed.stats.bytes} 字节，新沙箱 ${got.files} 个 / ${got.bytes} 字节`,
          );
        }
      }

      await this.phase(m.id, 'switch');
      await this.applyUserEgress(provider, newId, cfg.network);
      await this.switchSize(m.userId, toSize);
      switched = true;
      // 迁移时把到期时间拉长到 30 分钟，切换后调回用户的闲置设置，免得空转计费
      await ops.resetIdle(newId, cfg.lifecycle).catch((e: unknown) => {
        this.logger.warn(`新沙箱到期时间重置失败 ${newId}: ${String(e)}`);
      });

      await this.phase(m.id, 'cleanup');
      try {
        await ops.kill(oldId);
        await this.finish(m.id, 'done', null);
      } catch (e) {
        // 已切换成功：旧沙箱删不掉不影响使用，只提示
        this.logger.warn(`旧沙箱删除失败 ${oldId}: ${String(e)}`);
        await this.finish(
          m.id,
          'done',
          `已切换到新配置，但旧沙箱 ${oldId} 删除失败，需要到 E2B 控制台手动清理`,
        );
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.warn(`沙箱换档失败 migration=${m.id}: ${reason}`);
      if (!switched) {
        if (newId) {
          await ops.kill(newId).catch((err: unknown) => {
            this.logger.warn(`回滚：删除新沙箱失败 ${newId}: ${String(err)}`);
          });
        }
        if (oldId) {
          // 旧沙箱里可能留着几 GB 的归档：清掉，再把到期时间调回闲置设置
          const id = oldId;
          await ops
            .run(id, cleanupArchiveScript, 60_000)
            .catch(() => undefined);
          await ops.resetIdle(id, cfg.lifecycle).catch(() => {});
        }
      }
      await this.finish(
        m.id,
        'failed',
        switched
          ? `已切换到新配置，但收尾出错：${reason}`
          : `${reason}（旧沙箱与原配置保持不变）`,
      );
    }
  }

  /** 旧沙箱里统计 + 打包。工作区不存在（从没用过）时不打包，只建新沙箱。 */
  private async pack(
    ops: NonNullable<SandboxProvider['migration']>,
    sandboxId: string,
    ws: string,
    excludes: MigrationExcludes,
  ): Promise<{ archived: boolean; stats: { files: number; bytes: number } }> {
    const res = await ops.run(
      sandboxId,
      packScript(ws, excludes),
      RUN_TIMEOUT_MS,
    );
    if (res.output.includes('NO_WORKSPACE')) {
      return { archived: false, stats: { files: 0, bytes: 0 } };
    }
    if (res.exitCode !== 0 || !res.output.includes('PACKED')) {
      throw new Error(`打包失败：${res.output.slice(-300)}`);
    }
    return { archived: true, stats: parseStats(res.output) };
  }

  /**
   * 新沙箱是开着出站建的（要拉旧沙箱的归档）：切换前套回用户的出站设置。失败不回滚——
   * 之后每次 getUserSandbox 发现出站指纹不一致都会再同步，同步失败那轮不给 agent 沙箱。
   */
  private async applyUserEgress(
    provider: SandboxProvider,
    sandboxId: string,
    network: SandboxNetwork,
  ) {
    if (network.egress === 'open' || !provider.supportsEgressControl) return;
    await provider
      .applyEgress({ id: sandboxId, state: 'started' }, network)
      .catch((e: unknown) => {
        this.logger.warn(`新沙箱出站设置应用失败 ${sandboxId}: ${String(e)}`);
      });
  }

  private async switchSize(userId: string, size: SandboxSizeId) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { sandboxSize: size },
    });
  }

  private async phase(id: string, phase: MigrationPhase) {
    await this.prisma.sandboxMigration.update({
      where: { id },
      data: { phase },
    });
  }

  private async finish(
    id: string,
    status: 'done' | 'failed',
    message: string | null,
  ) {
    await this.prisma.sandboxMigration.update({
      where: { id },
      data: {
        status,
        message,
        finishedAt: new Date(),
        ...(status === 'done' ? { phase: 'done' } : {}),
      },
    });
  }
}

function toView(row: SandboxMigration): MigrationView {
  return {
    id: row.id,
    fromSize: row.fromSize,
    toSize: row.toSize,
    status:
      row.status === 'done' || row.status === 'failed' ? row.status : 'running',
    phase: row.phase,
    message: row.message,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes === null ? null : Number(row.totalBytes),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
