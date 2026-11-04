/**
 * 沙箱配置档位（/settings/sandbox「沙箱配置」）。目前只有 E2B 支持：规格由创建时的模板决定，
 * 每档一个预先构建好的模板（`scripts/build-e2b-template.ts all` 一次建齐 spark-<档位>）。
 * 换档 = 用新模板建新沙箱 + 迁移工作区（sandbox-migration.service.ts），已有沙箱不能原地扩容。
 *
 * 沙箱上用 metadata.size 标记档位；改造前建的沙箱没有这个标记，按 list 结果里的 vCPU / 内存反推。
 */

export const SANDBOX_SIZES = [
  { id: '2c2g', cpuCount: 2, memoryMB: 2048 },
  { id: '4c4g', cpuCount: 4, memoryMB: 4096 },
  { id: '4c8g', cpuCount: 4, memoryMB: 8192 },
  { id: '8c8g', cpuCount: 8, memoryMB: 8192 },
] as const;

export type SandboxSizeId = (typeof SANDBOX_SIZES)[number]['id'];

/** 用户没选过时的档位（与改造前的 E2B_TEMPLATE=spark-2c2g 一致） */
export const DEFAULT_SANDBOX_SIZE: SandboxSizeId = '2c2g';

export function isSandboxSizeId(v: unknown): v is SandboxSizeId {
  return SANDBOX_SIZES.some((s) => s.id === v);
}

/**
 * 档位 → E2B 模板名。默认档沿用 E2B_TEMPLATE（改造前就是它建的沙箱），其余档固定命名 spark-<id>，
 * 可用 E2B_TEMPLATE_<ID>（如 E2B_TEMPLATE_4C8G）覆盖。
 */
export function e2bTemplateFor(size: SandboxSizeId): string {
  const override = process.env[`E2B_TEMPLATE_${size.toUpperCase()}`]?.trim();
  if (override) return override;
  // 默认档沿用改造前的行为：没设 E2B_TEMPLATE 就用 E2B 自带的 base（2 vCPU / 512 MB）
  if (size === DEFAULT_SANDBOX_SIZE) {
    return process.env.E2B_TEMPLATE?.trim() || 'base';
  }
  return `spark-${size}`;
}

/** 按规格反推档位（改造前建的沙箱没有 metadata.size）；对不上任何档返回 undefined。 */
export function sizeFromSpecs(
  cpuCount: number | undefined,
  memoryMB: number | undefined,
): SandboxSizeId | undefined {
  return SANDBOX_SIZES.find(
    (s) => s.cpuCount === cpuCount && s.memoryMB === memoryMB,
  )?.id;
}
