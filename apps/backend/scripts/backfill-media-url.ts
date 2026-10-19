/**
 * 一次性回填：给已完成、但只有本地文件（filePath）的 aigc 产物版本补上 CDN 地址（url）。
 *
 * 背景：aigc 产物从「下载转存到 data/media」改为「只存 CDN 地址」后，历史版本只有 filePath，
 * 换 worktree / 机器就因本地文件缺失而取不到图。这里按 providerTaskId 向 aigc 查产物地址补齐。
 * 本地拼接产物（ffmpeg-concat，没有 task_id）不在范围内，仍走本地文件；filePath 保留不动作兜底。
 *
 * 用法（在 apps/backend 下，先切 node 22）：
 *   node --env-file=.env --import tsx scripts/backfill-media-url.ts            # 回填
 *   node --env-file=.env --import tsx scripts/backfill-media-url.ts --dry-run  # 只看不写
 * 走代理时加 NODE_USE_ENV_PROXY=1（Node 22 的 fetch 默认不认 HTTPS_PROXY）。
 */
import { PrismaClient } from '@prisma/client';
import { AigcClient } from '../src/aigc/aigc.client';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();
  const aigc = new AigcClient();
  try {
    const versions = await prisma.mediaVersion.findMany({
      where: { status: 'done', url: null, providerTaskId: { not: null } },
      select: { id: true, providerTaskId: true },
    });
    console.log(`待回填 ${versions.length} 条${dryRun ? '（dry-run）' : ''}`);

    let filled = 0;
    const skipped: string[] = [];
    for (const v of versions) {
      if (!v.providerTaskId) continue;
      try {
        const task = await aigc.getTask(v.providerTaskId);
        const url = task.output_data?.image_url ?? task.output_data?.video_url;
        if (task.status !== 'completed' || !url) {
          skipped.push(`${v.id}: task ${task.status}，无产物地址`);
          continue;
        }
        if (!dryRun) {
          await prisma.mediaVersion.update({
            where: { id: v.id },
            data: { url },
          });
        }
        filled++;
      } catch (e) {
        skipped.push(`${v.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(
      `${dryRun ? '可回填' : '已回填'} ${filled} 条，跳过 ${skipped.length} 条`,
    );
    for (const s of skipped) console.log(`  - ${s}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
