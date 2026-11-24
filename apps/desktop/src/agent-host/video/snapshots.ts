/**
 * agent 改剪辑工程前的快照：agent 用 write_file / edit_file 写 `*.sparkvideo.json` 之前，先把磁盘上的旧版存一份，
 * 剪辑器的「撤销 agent 修改」据此一步步恢复（剪辑器关着时 agent 改的也能撤）。
 *
 * - 一轮运行（runKey）里同一个工程只在第一次写之前存一次：撤销的粒度是「agent 这一轮的全部修改」；
 * - 存在应用数据目录（`<profile>/video-snapshots/<会话 id>/<工程路径编码>/`），不放进工作区，免得 agent 列目录看到；
 * - 每个工程最多留 MAX_SNAPSHOTS 份，多了删最旧的；
 * - 恢复 = 把最新一份写回工程文件并删掉它（再点一次恢复更早的一轮）。
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { PROJECT_FILE_SUFFIX } from '@agent-test/video-schema';
import { hostI18n } from '../i18n';
import { resolveWritable, writeFileAtomic } from './project-files';

export const MAX_SNAPSHOTS = 10;

export interface SnapshotInfo {
  /** 还能撤销几轮 */
  count: number;
  /** 最新一份的时间（毫秒）；没有为 null */
  latestAt: number | null;
}

export class VideoSnapshots {
  /** 本轮已经存过的 `runKey\0绝对路径` */
  private readonly captured = new Set<string>();

  constructor(private readonly dir: string) {}

  /** 这个会话全部快照所在的目录（存储占用统计；删会话 / 清缓存时整个删掉） */
  conversationDir(conversationId: string): string {
    return join(this.dir, encodeURIComponent(conversationId));
  }

  /** 存着快照的会话 id（含已删会话残留的） */
  async conversationIds(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => []);
    return names.map((n) => decodeURIComponent(n));
  }

  private folder(conversationId: string, relPath: string): string {
    return join(this.conversationDir(conversationId), encodeURIComponent(relPath));
  }

  /** 文件名 `<毫秒>-<序号>.json`，按名字排序即时间顺序 */
  private async entries(folder: string): Promise<string[]> {
    const names = await readdir(folder).catch(() => []);
    return names.filter((n) => n.endsWith('.json')).sort();
  }

  /**
   * agent 写文件前调用（工作区沙箱的 write / edit）：不是剪辑工程、文件还不存在（新建）、本轮已存过的都跳过。
   * 失败不抛：快照只是兜底，不能挡住 agent 写文件。
   */
  async capture(conversationId: string, workspaceDir: string, filePath: string, runKey: string): Promise<void> {
    const abs = resolve(workspaceDir, filePath);
    if (!abs.endsWith(PROJECT_FILE_SUFFIX)) return;
    const rel = relative(workspaceDir, abs);
    if (rel.startsWith('..') || rel === '') return;
    const key = `${runKey}\0${abs}`;
    if (this.captured.has(key)) return;
    this.captured.add(key);
    try {
      const content = await readFile(abs, 'utf8');
      const folder = this.folder(conversationId, rel.split(sep).join('/'));
      await mkdir(folder, { recursive: true });
      const existing = await this.entries(folder);
      const seq = String(existing.length).padStart(3, '0');
      await writeFile(join(folder, `${Date.now()}-${seq}.json`), content, 'utf8');
      const all = await this.entries(folder);
      for (const old of all.slice(0, Math.max(0, all.length - MAX_SNAPSHOTS))) await rm(join(folder, old), { force: true });
    } catch {
      // 文件不存在（agent 新建工程）或磁盘问题：不存
    }
  }

  async info(conversationId: string, relPath: string): Promise<SnapshotInfo> {
    const names = await this.entries(this.folder(conversationId, relPath));
    const latest = names.at(-1);
    return { count: names.length, latestAt: latest ? Number(latest.split('-')[0]) : null };
  }

  /** 把最新一份快照写回工程文件并删掉它；没有快照时报错 */
  async restoreLatest(conversationId: string, workspaceDir: string, relPath: string): Promise<SnapshotInfo> {
    const folder = this.folder(conversationId, relPath);
    const latest = (await this.entries(folder)).at(-1);
    if (!latest) throw new Error(hostI18n.t('errors.video.noSnapshot'));
    const content = await readFile(join(folder, latest), 'utf8');
    await writeFileAtomic(await resolveWritable(workspaceDir, relPath), content);
    await rm(join(folder, latest), { force: true });
    return this.info(conversationId, relPath);
  }
}
