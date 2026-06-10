/**
 * skill-installer — 从 GitHub codeload tarball 下载并安装技能到磁盘。
 *
 * 设计决策：
 * - 不依赖 git：直接使用 codeload.github.com tar.gz 接口，无需 git 可执行文件。
 * - 原子性：先解压到 tmp 目录完整校验，通过后再 rename/copy 到最终位置；
 *   校验失败时 finally 清理 tmp，destRoot 无残留。
 * - 安全性：显式检查 tarball 条目路径，拒绝含 '..' 或以 '/' 开头的路径，
 *   防止 path traversal 即使 tar 包自身已有部分防护，也额外断言确保测试可验证。
 * - 大小限制：单文件 >512KB 跳过（与 skills.service.ts:41 保持一致）；
 *   解压后目录总量 >20MB 抛 BusinessException，不写入 destRoot。
 * - ref 回退：未显式指定 ref 时先试 main，404 则自动重试 master；
 *   显式指定时不回退，直接抛错。
 */

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as tar from 'tar';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { parseSkillMd } from './skill-parser';
import { validateSkill } from './skill-parser';

/** 安装结果：DB 行所需元数据。 */
export interface InstalledSkill {
  name: string;
  description: string;
  /** github:<owner>/<repo>#<path>@<ref> */
  source: string;
}

/** 单文件跳过阈值，与 skills.service.ts 保持一致。 */
const MAX_FILE_BYTES = 512 * 1024;

/** 技能目录总大小上限：20MB。 */
const MAX_SKILL_DIR_BYTES = 20 * 1024 * 1024;

/**
 * 断言 tarball 条目路径安全：拒绝含 '..' 片段或以 '/' 开头的路径。
 *
 * 单独导出以便：
 * 1. 在 extractSkillFromTarball 流程中调用。
 * 2. 单元测试直接验证此纯函数，覆盖路径穿越用例（不依赖能否手工伪造 tar 条目）。
 */
export function assertSafeEntryPath(entryPath: string): void {
  // 绝对路径
  if (entryPath.startsWith('/')) {
    throw new BusinessException(ErrorCodes.SKILL_INSTALL_PATH_TRAVERSAL);
  }
  // 含 '..' 片段（处理 Unix / Windows 风格）
  const segments = entryPath.replace(/\\/g, '/').split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new BusinessException(ErrorCodes.SKILL_INSTALL_PATH_TRAVERSAL);
  }
}

/**
 * 递归计算目录总字节数，用于超量检测。
 */
function dirTotalBytes(dir: string): number {
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      total += dirTotalBytes(abs);
    } else if (ent.isFile()) {
      total += statSync(abs).size;
    }
  }
  return total;
}

/**
 * 纯逻辑核心：从 tarball Buffer 解出 <path> 子目录、校验、落盘到 destRoot/<name>/。
 *
 * 流程：
 * 1. 将 tarball Buffer 写到 tmpDir/in.tar.gz
 * 2. 解压到 tmpExtractDir，仅保留匹配 repoPrefix/<path>/ 前缀的条目，
 *    过滤中同时调用 assertSafeEntryPath 拒绝穿越路径，单文件 >512KB 跳过。
 * 3. 读取 SKILL.md，parseSkillMd + validateSkill，任何错误 → BusinessException。
 * 4. 计算解压后目录总大小，>20MB → BusinessException。
 * 5. 原子 mv/cp 到 destRoot/<name>/；最终 finally 清理所有 tmp。
 */
export async function extractSkillFromTarball(opts: {
  tarball: Buffer;
  repoPrefix: string;
  path: string;
  destRoot: string;
  source: string;
}): Promise<InstalledSkill> {
  const { tarball, repoPrefix, path: skillPath, destRoot, source } = opts;

  // 先检查 path 本身是否含穿越片段（installSkillFromGithub 传入的 path 参数也校验）
  assertSafeEntryPath(skillPath);

  const tmpDir = mkdtempSync(join(tmpdir(), 'skill-install-'));
  const tmpExtractDir = join(tmpDir, 'extract');
  mkdirSync(tmpExtractDir, { recursive: true });

  try {
    // 写 tarball 到临时文件
    const tarFile = join(tmpDir, 'in.tar.gz');
    writeFileSync(tarFile, tarball);

    // 解压前缀过滤：仅展开属于指定子路径的条目
    // strip 用于去掉 repoPrefix/<skillPath>/ 的层级前缀，直接展开到 tmpExtractDir
    const entryPrefix = `${repoPrefix}/${skillPath}/`;
    // strip count = (repoPrefix 层级数) + (skillPath 层级数)
    // repoPrefix 是单段（'skills-main'），skillPath 可能是多段（'a/b/c'）
    const stripCount =
      repoPrefix.split('/').length + skillPath.split('/').length;

    // 使用 filter 钩子校验路径安全并过滤条目
    // tar v7 filter(path, entry) 中 entry 是 ReadEntry 对象，有 .type ('File'|'Directory') 和 .size
    await tar.x({
      file: tarFile,
      cwd: tmpExtractDir,
      strip: stripCount,
      filter: (entryPath: string, entry: tar.ReadEntry) => {
        // 路径安全断言（注：tar.x 会在 filter 里抛出时中止并传播）
        assertSafeEntryPath(entryPath);

        // 只展开属于目标子路径的条目（含子目录条目本身 entryPrefix 去掉末尾 /）
        if (!entryPath.startsWith(entryPrefix) && entryPath !== entryPrefix.slice(0, -1)) {
          return false;
        }

        // 单文件大小限制：>512KB 的文件跳过（目录条目 type=Directory，不跳过）
        if (entry && entry.type === 'File' && entry.size != null && entry.size > MAX_FILE_BYTES) {
          return false;
        }
        return true;
      },
    } as Parameters<typeof tar.x>[0]);

    // 检查 SKILL.md 是否存在
    const skillMdPath = join(tmpExtractDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      throw new BusinessException(ErrorCodes.SKILL_INSTALL_INVALID);
    }

    // 解析与校验 SKILL.md
    const raw = await readFile(skillMdPath, 'utf8');
    const dirName = basename(skillPath);
    const parsed = parseSkillMd(raw, dirName);
    const errors = validateSkill({
      name: parsed.name,
      description: parsed.description,
      dirName,
      compatibility: parsed.compatibility,
    });
    if (errors.length > 0) {
      throw new BusinessException(ErrorCodes.SKILL_INSTALL_INVALID);
    }

    // 目录总大小限制
    const totalBytes = dirTotalBytes(tmpExtractDir);
    if (totalBytes > MAX_SKILL_DIR_BYTES) {
      throw new BusinessException(ErrorCodes.SKILL_INSTALL_TOO_LARGE);
    }

    // 原子落盘：将 tmpExtractDir 内容移到 destRoot/<name>/
    const finalDest = join(destRoot, parsed.name);
    mkdirSync(destRoot, { recursive: true });

    // 如果已存在（重装），先删除
    if (existsSync(finalDest)) {
      rmSync(finalDest, { recursive: true, force: true });
    }

    // 尝试同盘 rename（原子），跨盘时 rename 会失败，降级到 cp
    try {
      renameSync(tmpExtractDir, finalDest);
    } catch {
      // 跨设备时 rename 失败，用递归 cp 再 rm
      await cp(tmpExtractDir, finalDest, { recursive: true });
    }

    return {
      name: parsed.name,
      description: parsed.description,
      source,
    };
  } finally {
    // 无论成败都清理 tmp 目录（rename 成功后 tmpExtractDir 已不存在，rmSync 静默处理）
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 入口：下载 GitHub tarball（main → master 回退）后调用 extractSkillFromTarball。
 *
 * codeload URL 格式：https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>
 * tarball 顶层前缀格式：<repo>-<ref>
 *
 * ref 策略：
 * - 未显式指定：先试 main，404 时自动重试 master。
 * - 显式指定：不回退，直接失败。
 */
export async function installSkillFromGithub(opts: {
  repo: string;
  path: string;
  ref?: string;
  destRoot: string;
}): Promise<InstalledSkill> {
  const { repo, path: skillPath, destRoot } = opts;

  // 解析 owner/repoName
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new BusinessException(ErrorCodes.SKILL_INSTALL_NOT_FOUND);
  }

  const refExplicit = opts.ref !== undefined;
  const refsToTry = refExplicit ? [opts.ref!] : ['main', 'master'];

  let lastStatus = 0;
  let tarball: Buffer | null = null;
  let usedRef = '';

  for (const ref of refsToTry) {
    const url = `https://codeload.github.com/${owner}/${repoName}/tar.gz/${ref}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const ab = await resp.arrayBuffer();
      tarball = Buffer.from(ab);
      usedRef = ref;
      break;
    }
    lastStatus = resp.status;
    // 只在 404 时继续尝试下一个 ref；其他错误直接退出循环
    if (resp.status !== 404) break;
  }

  if (!tarball) {
    throw new BusinessException(ErrorCodes.SKILL_INSTALL_NOT_FOUND);
  }

  const repoPrefix = `${repoName}-${usedRef}`;
  const source = `github:${repo}#${skillPath}@${usedRef}`;

  return extractSkillFromTarball({
    tarball,
    repoPrefix,
    path: skillPath,
    destRoot,
    source,
  });
}
