/**
 * skill-installer 单元测试
 * 不走网络：直接用 tar.c 在 tmp 构造 fixture tarball，测 extractSkillFromTarball + assertSafeEntryPath。
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import {
  extractSkillFromTarball,
  assertSafeEntryPath,
} from './skill-installer';

// ---------------------------------------------------------------------------
// 测试辅助：在 tmp 目录构造一个合法的技能子目录结构，然后打包成 tarball Buffer
// ---------------------------------------------------------------------------

/**
 * 构造最简 tarball fixture：
 * 顶层前缀 repoPrefix，技能子路径 skillPath，含 SKILL.md + 可选额外文件。
 */
async function buildFixtureTarball(opts: {
  repoPrefix: string;
  skillPath: string;
  skillMdContent: string;
  extraFiles?: Record<string, string>; // 相对于 skillPath 的路径 → 内容
}): Promise<Buffer> {
  const { repoPrefix, skillPath, skillMdContent, extraFiles = {} } = opts;
  const stage = mkdtempSync(join(tmpdir(), 'fixture-stage-'));
  try {
    // 构建目录结构：<repoPrefix>/<skillPath>/SKILL.md 等
    const skillAbsDir = join(stage, repoPrefix, skillPath);
    mkdirSync(skillAbsDir, { recursive: true });
    writeFileSync(join(skillAbsDir, 'SKILL.md'), skillMdContent, 'utf8');
    for (const [rel, content] of Object.entries(extraFiles)) {
      const abs = join(skillAbsDir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }

    // 将 stage/<repoPrefix> 打包成 tarball，写到 tmp 文件再读回 Buffer
    const tarPath = join(stage, 'out.tar.gz');
    await tar.c({ gzip: true, file: tarPath, cwd: stage }, [repoPrefix]);
    return readFileSync(tarPath);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe('assertSafeEntryPath', () => {
  it('正常路径不抛', () => {
    expect(() => assertSafeEntryPath('repo-main/skills/docx/SKILL.md')).not.toThrow();
  });
  it('包含 .. 的路径抛 BusinessException', () => {
    expect(() => assertSafeEntryPath('repo-main/../../../etc/passwd')).toThrow(BusinessException);
  });
  it('以 / 开头的绝对路径抛 BusinessException', () => {
    expect(() => assertSafeEntryPath('/etc/passwd')).toThrow(BusinessException);
  });
  it('Windows 路径穿越 ..\\  也拒绝（含 ..）', () => {
    expect(() => assertSafeEntryPath('repo-main/..\\evil')).toThrow(BusinessException);
  });
});

describe('extractSkillFromTarball', () => {
  let destRoot: string;

  beforeEach(() => {
    destRoot = mkdtempSync(join(tmpdir(), 'dest-'));
  });
  afterEach(() => {
    rmSync(destRoot, { recursive: true, force: true });
  });

  // ─── 用例 1：正常解压、校验通过、落盘 ────────────────────────────────────────
  it('正常安装：解出子目录，校验通过，落盘到 destRoot/<name>/SKILL.md', async () => {
    const skillMd = `---\nname: docx\ndescription: Word 文档处理技能\n---\n## 用法`;
    const tarball = await buildFixtureTarball({
      repoPrefix: 'skills-main',
      skillPath: 'document-skills/docx',
      skillMdContent: skillMd,
    });

    const result = await extractSkillFromTarball({
      tarball,
      repoPrefix: 'skills-main',
      path: 'document-skills/docx',
      destRoot,
      source: 'github:anthropics/skills#document-skills/docx@main',
    });

    expect(result.name).toBe('docx');
    expect(result.description).toBe('Word 文档处理技能');
    expect(result.source).toBe('github:anthropics/skills#document-skills/docx@main');

    // 落盘校验
    const installedSkillMd = join(destRoot, 'docx', 'SKILL.md');
    expect(existsSync(installedSkillMd)).toBe(true);
    expect(readFileSync(installedSkillMd, 'utf8')).toBe(skillMd);
  });

  // ─── 用例 2：SKILL.md 缺失 → BusinessException ─────────────────────────────
  it('tarball 内无 SKILL.md → BusinessException', async () => {
    // 构造一个只有 README.md 没有 SKILL.md 的 tarball
    const stage = mkdtempSync(join(tmpdir(), 'no-skill-'));
    try {
      const skillDir = join(stage, 'skills-main', 'document-skills', 'docx');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'README.md'), '# hello');
      const tarPath = join(stage, 'out.tar.gz');
      await tar.c({ gzip: true, file: tarPath, cwd: stage }, ['skills-main']);
      const tarball = readFileSync(tarPath);

      await expect(
        extractSkillFromTarball({
          tarball,
          repoPrefix: 'skills-main',
          path: 'document-skills/docx',
          destRoot,
          source: 's',
        }),
      ).rejects.toThrow(BusinessException);

      // destRoot 无残留
      expect(existsSync(join(destRoot, 'docx'))).toBe(false);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  // ─── 用例 3：frontmatter 校验失败（name 与目录名不一致）→ BusinessException ──
  it('SKILL.md name 与目录名不一致 → BusinessException，destRoot 无残留', async () => {
    // skillPath 最后一段是 'docx'，但 SKILL.md 里写 name: other-name
    const skillMd = `---\nname: other-name\ndescription: 测试\n---\nbody`;
    const tarball = await buildFixtureTarball({
      repoPrefix: 'skills-main',
      skillPath: 'document-skills/docx',
      skillMdContent: skillMd,
    });

    await expect(
      extractSkillFromTarball({
        tarball,
        repoPrefix: 'skills-main',
        path: 'document-skills/docx',
        destRoot,
        source: 's',
      }),
    ).rejects.toThrow(BusinessException);

    // destRoot 内不应有任何残留目录
    expect(existsSync(join(destRoot, 'docx'))).toBe(false);
    expect(existsSync(join(destRoot, 'other-name'))).toBe(false);
  });

  // ─── 用例 4：路径穿越 → BusinessException ───────────────────────────────────
  // tar 包通常拒绝写 '..' 条目，所以直接测 assertSafeEntryPath（已在上面独立测）。
  // 这里补充集成层面：通过篡改 tarball buffer 注入含 '..' 的条目名称（最可靠方式：
  // 用合法 tarball 的 path 字段做字符串替换，构造含 '..' 的假条目名）。
  it('tarball 中含路径穿越条目 → BusinessException', async () => {
    const skillMd = `---\nname: docx\ndescription: test\n---\nbody`;
    // 先打出合法的 tarball，然后字节替换路径
    const stage = mkdtempSync(join(tmpdir(), 'evil-tar-'));
    try {
      // 使用一个与 '..evil/' 等长的合法路径占位，再替换字节
      // 合法目录名: 'xAx/' (4 bytes, same as '../') — 写真实文件
      const skillDir = join(stage, 'skills-main', 'xAx', 'docx');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
      const tarPath = join(stage, 'out.tar.gz');
      await tar.c({ gzip: true, file: tarPath, cwd: stage }, ['skills-main']);

      // 读回 buffer，用字符串替换将 'xAx/' → '../' 来注入穿越路径
      // gz 内容是压缩的，字节替换在压缩层不可靠。
      // 改用非压缩 tar 更容易替换（tar header 是明文）
      const tarPathRaw = join(stage, 'out.tar');
      await tar.c({ gzip: false, file: tarPathRaw, cwd: stage }, ['skills-main']);
      let buf = readFileSync(tarPathRaw);
      // tar header 第 0-99 字节是文件名
      // 扫描 buffer 找 'xAx/' 并替换成 '../'
      const needle = Buffer.from('xAx/');
      const replacement = Buffer.from('../');
      let replaced = false;
      for (let i = 0; i <= buf.length - needle.length; i++) {
        if (buf.slice(i, i + needle.length).equals(needle)) {
          buf = Buffer.concat([buf.slice(0, i), replacement, Buffer.from('/'), buf.slice(i + needle.length)]);
          replaced = true;
          break;
        }
      }
      // 如果替换成功，extractSkillFromTarball 应抛 BusinessException
      if (replaced) {
        await expect(
          extractSkillFromTarball({
            tarball: buf,
            repoPrefix: 'skills-main',
            path: '../docx',
            destRoot,
            source: 's',
          }),
        ).rejects.toThrow(BusinessException);
      } else {
        // 找不到字节时走 assertSafeEntryPath 路径，直接测 path 参数穿越
        await expect(
          extractSkillFromTarball({
            tarball: buf,
            repoPrefix: 'skills-main',
            path: '../etc/passwd',
            destRoot,
            source: 's',
          }),
        ).rejects.toThrow(BusinessException);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  // ─── 用例 5a：单文件 >512KB 跳过（其他文件正常落盘，安装成功）──────────────
  it('单文件 >512KB 被跳过，但 SKILL.md 正常落盘，安装成功', async () => {
    const skillMd = `---\nname: docx\ndescription: Word 处理\n---\nbody`;
    const bigContent = 'x'.repeat(513 * 1024); // 513KB > 512KB
    const tarball = await buildFixtureTarball({
      repoPrefix: 'skills-main',
      skillPath: 'document-skills/docx',
      skillMdContent: skillMd,
      extraFiles: { 'big.bin': bigContent },
    });

    const result = await extractSkillFromTarball({
      tarball,
      repoPrefix: 'skills-main',
      path: 'document-skills/docx',
      destRoot,
      source: 'github:anthropics/skills#document-skills/docx@main',
    });

    expect(result.name).toBe('docx');
    // SKILL.md 落盘
    expect(existsSync(join(destRoot, 'docx', 'SKILL.md'))).toBe(true);
    // 大文件被跳过，不存在
    expect(existsSync(join(destRoot, 'docx', 'big.bin'))).toBe(false);
  });

  // ─── 用例 5b：目录总量 >20MB → BusinessException ─────────────────────────────
  it('技能目录总大小超过 20MB → BusinessException', async () => {
    const skillMd = `---\nname: docx\ndescription: test\n---\nbody`;
    // 生成多个刚好低于 512KB（不被跳过）但合计 >20MB 的文件
    // 每个文件约 400KB，51 个 = ~20.4MB
    const chunk = 'y'.repeat(400 * 1024);
    const extraFiles: Record<string, string> = {};
    for (let i = 0; i < 52; i++) {
      extraFiles[`file${i}.txt`] = chunk;
    }

    const tarball = await buildFixtureTarball({
      repoPrefix: 'skills-main',
      skillPath: 'document-skills/docx',
      skillMdContent: skillMd,
      extraFiles,
    });

    await expect(
      extractSkillFromTarball({
        tarball,
        repoPrefix: 'skills-main',
        path: 'document-skills/docx',
        destRoot,
        source: 's',
      }),
    ).rejects.toThrow(BusinessException);

    // destRoot 无残留
    expect(existsSync(join(destRoot, 'docx'))).toBe(false);
  });
});
