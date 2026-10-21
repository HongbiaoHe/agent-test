/**
 * 构建 Spark 用的 E2B 沙箱模板（规格只能在模板构建时指定，Sandbox.create 不能传 CPU / 内存）。
 *
 * 只影响**新建**的沙箱：已有沙箱沿用创建时的模板，换模板不迁移、不改动它们的文件。
 * 构建后在 .env 设 E2B_TEMPLATE=<模板名>，新用户首次开机即用新规格。
 *
 * Hobby 计划上限：8 vCPU / 8192 MB（超出构建直接 400）。
 *
 * 用法（在 apps/backend 下，先切 node 22）：
 *   node --env-file=.env --import tsx scripts/build-e2b-template.ts                   # spark-2c2g（2 vCPU / 2048 MB）
 *   node --env-file=.env --import tsx scripts/build-e2b-template.ts my-tpl 4 4096     # 自定义名字 / vCPU / 内存 MB
 * 走代理时加 NODE_USE_ENV_PROXY=1（Node 22 的 fetch 默认不认 HTTPS_PROXY）。
 */
import { Template } from 'e2b';

async function main(): Promise<void> {
  const [name = 'spark-2c2g', cpu = '2', memory = '2048'] =
    process.argv.slice(2);
  const cpuCount = Number(cpu);
  const memoryMB = Number(memory);
  if (!Number.isInteger(cpuCount) || !Number.isInteger(memoryMB)) {
    throw new Error(`vCPU / 内存必须是整数：${cpu} / ${memory}`);
  }

  console.log(`构建 ${name}：${cpuCount} vCPU / ${memoryMB} MB（基于 base）…`);
  // 内容与 base 完全一致，只改规格：agent 依赖的工具（python3 等）都来自 base
  const info = await Template.build(Template().fromTemplate('base'), name, {
    cpuCount,
    memoryMB,
  });
  console.log(
    `完成 templateId=${info.templateId}。在 .env 设 E2B_TEMPLATE=${name}`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
