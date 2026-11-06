import type { CompositeBackend } from 'deepagents';
import type { GuardedSandbox } from '../agent/guarded-sandbox';
import { mountSkills, uploadSkillsToSandbox } from './skills-mount';

/** memory 策略实际返回 CompositeBackend（AnyBackendProtocol 是 V1/V2 联合，收窄后才有 ls / ReadResult） */
const composite = (b: unknown) => b as CompositeBackend;

describe('mountSkills memory', () => {
  const skills = [
    {
      name: 'tvc',
      files: { 'SKILL.md': '先读 `./references/a.md`', 'references/a.md': 'A' },
    },
  ];

  it('无沙箱：skillsDir 路由到只读 store，read_file 读到 SKILL.md（相对引用已绝对化），write / edit 被拒', async () => {
    const { backend: raw, skillsDir } = await mountSkills({
      strategy: 'memory',
      skillsDir: '/skills/',
      skills,
    });
    const backend = composite(raw);
    expect(skillsDir).toBe('/skills');
    const md = await backend.read('/skills/tvc/SKILL.md');
    expect(md.content).toContain('`/skills/tvc/references/a.md`');
    expect(
      (await backend.read('/skills/tvc/references/a.md')).content,
    ).toContain('A');
    expect((await backend.write('/skills/tvc/SKILL.md', 'x')).error).toMatch(
      /只读/,
    );
    expect(
      (await backend.edit('/skills/tvc/SKILL.md', 'a', 'b')).error,
    ).toMatch(/只读/);
  });

  it('自定义 skillsDir：/workspace/skills 下也能 ls 到技能目录', async () => {
    const { backend } = await mountSkills({
      strategy: 'memory',
      skillsDir: '/workspace/skills',
      skills,
    });
    const listing = await composite(backend).ls('/workspace/skills/');
    expect(JSON.stringify(listing)).toContain('tvc');
  });
});

describe('uploadSkillsToSandbox 去重', () => {
  const def = { name: 'tvc-director', files: { 'SKILL.md': '# tvc' } };

  const mkSb = (manifest: {
    content: Uint8Array | null;
    error: string | null;
  }) => {
    const uploaded: Array<[string, Uint8Array]> = [];
    const sbm = {
      skillsDir: '/workspace/skills',
      downloadFiles: jest
        .fn()
        .mockResolvedValue([
          { path: '/workspace/skills/.manifest', ...manifest },
        ]),
      execute: jest.fn().mockResolvedValue({ output: '', exitCode: 0 }),
      uploadFiles: jest.fn(async (files: Array<[string, Uint8Array]>) => {
        uploaded.push(...files);
        return files.map(([p]) => ({ path: p, error: null }));
      }),
    } as unknown as GuardedSandbox;
    return { sbm, uploaded };
  };

  it('无 manifest（首次/新沙箱）→ 先清空旧目录再全量上传 + 写 .manifest', async () => {
    const { sbm, uploaded } = mkSb({ content: null, error: 'file_not_found' });
    await mountSkills({ strategy: 'sandbox', sandbox: sbm, skills: [def] });
    expect(sbm.execute).toHaveBeenCalledWith('rm -rf skills');
    const paths = uploaded.map(([p]) => p);
    expect(paths).toContain('/workspace/skills/tvc-director/SKILL.md');
    expect(paths).toContain('/workspace/skills/.manifest');
  });

  it('SKILL.md 的相对引用改写到工作区技能库', async () => {
    const { sbm, uploaded } = mkSb({ content: null, error: 'file_not_found' });
    await uploadSkillsToSandbox(sbm, [
      { ...def, files: { 'SKILL.md': '先读 `./references/a.md`' } },
    ]);
    const md = uploaded.find(([p]) => p.endsWith('/SKILL.md'))![1];
    expect(new TextDecoder().decode(md)).toBe(
      '先读 `/workspace/skills/tvc-director/references/a.md`',
    );
  });

  it('manifest 指纹一致 → 跳过：不 execute、不 uploadFiles', async () => {
    const first = mkSb({ content: null, error: 'file_not_found' });
    await uploadSkillsToSandbox(first.sbm, [def]);
    const fingerprint = first.uploaded.find(
      ([p]) => p === '/workspace/skills/.manifest',
    )![1];
    const second = mkSb({ content: fingerprint, error: null });
    await uploadSkillsToSandbox(second.sbm, [def]);
    expect(second.sbm.execute).not.toHaveBeenCalled();
    expect(second.sbm.uploadFiles).not.toHaveBeenCalled();
  });

  it('技能集变化（换模式少勾一个）→ 指纹不符 → 重新清空并上传', async () => {
    const first = mkSb({ content: null, error: 'file_not_found' });
    await uploadSkillsToSandbox(first.sbm, [
      def,
      { name: 'doc', files: { 'SKILL.md': '# doc' } },
    ]);
    const fingerprint = first.uploaded.find(
      ([p]) => p === '/workspace/skills/.manifest',
    )![1];
    const second = mkSb({ content: fingerprint, error: null });
    await uploadSkillsToSandbox(second.sbm, [def]);
    expect(second.sbm.execute).toHaveBeenCalledWith('rm -rf skills');
    expect(second.uploaded.map(([p]) => p)).not.toContain(
      '/workspace/skills/doc/SKILL.md',
    );
  });

  it('任一文件上传失败 → 抛错', async () => {
    const { sbm } = mkSb({ content: null, error: 'file_not_found' });
    (sbm.uploadFiles as jest.Mock).mockResolvedValue([
      { path: '/workspace/skills/tvc-director/SKILL.md', error: 'disk full' },
    ]);
    await expect(uploadSkillsToSandbox(sbm, [def])).rejects.toThrow(
      /disk full/,
    );
  });
});
