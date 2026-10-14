/**
 * 沙箱提供方端到端测试：真实云沙箱（E2B 或 Daytona，按 SANDBOX_PROVIDER）走一遍
 * agent worker / 文件接口 / 状态接口实际用到的全部函数。
 *
 * 覆盖：创建 → 技能上传与去重 → deepagents 文件工具（经 GuardedSandbox 虚拟根）→ execute
 * （含非零退出码）→ /skills 只读 → 工作区列举/预览 → 状态接口 → 停机（模拟闲置）→
 * 状态只读不唤醒 → 文件接口唤醒且文件仍在 → 再次获取不裂变新沙箱。
 * 每个提供方固定一个测试 userId（不碰真实用户数据）：首次运行新建沙箱，之后复用；
 * **从不删除沙箱**（按用户要求），由提供方的闲置停机/暂停策略回收资源。
 *
 * 运行（apps/backend 下，凭据取自 .env）：
 *   SANDBOX_PROVIDER=e2b     node --import tsx test/sandbox-provider.e2e.ts
 *   SANDBOX_PROVIDER=daytona node --import tsx test/sandbox-provider.e2e.ts
 */
import assert from 'node:assert/strict';
import { Daytona } from '@daytonaio/sdk';
import { Sandbox } from 'e2b';
import {
  findUserSandbox,
  getUserSandbox,
  listDir,
  listWorkspaceFiles,
  pickUserSandbox,
  readFilePreview,
  startUserDesktop,
  uploadSkillsToSandbox,
} from '../src/agent/sandbox';
import {
  DEFAULT_SANDBOX_LIFECYCLE,
  getSandboxProvider,
} from '../src/agent/sandbox-providers';
import type { SandboxSettingsService } from '../src/sandbox/sandbox-settings.service';
import { SandboxStatusService } from '../src/sandbox/sandbox.service';
import type { SkillDef } from '../src/skills/skills.service';

// 命令行显式指定的 SANDBOX_PROVIDER 优先于 .env（loadEnvFile 不覆盖已存在的变量）
process.loadEnvFile('.env');

const provider = getSandboxProvider();
const USER = `e2e-sandbox-${provider.name}`;
// 本脚本按 SANDBOX_PROVIDER 测单个提供方：偏好固定解析为它（用户偏好链路由整站 e2e 覆盖）
const status = new SandboxStatusService({
  resolve: () =>
    Promise.resolve({
      provider: provider.name,
      lifecycle: DEFAULT_SANDBOX_LIFECYCLE,
    }),
} as unknown as SandboxSettingsService);

const results: Array<{ name: string; ok: boolean; note?: string }> = [];
async function step(name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name} (${Date.now() - t0}ms)${note ? ` — ${note}` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, note: msg });
    console.log(`❌ ${name} — ${msg}`);
  }
}

/**
 * 模拟闲置停机：E2B 暂停 / Daytona 停机（与自动到期后的状态一致）。
 * Daytona stop() 返回时可能仍是 'stopping'，轮询到 'stopped' 再继续。
 */
async function stopRemote(id: string) {
  if (provider.name === 'e2b') await Sandbox.pause(id);
  else {
    const d = new Daytona();
    await d.stop(await d.get(id));
  }
  for (let i = 0; i < 30; i++) {
    if ((await pickUserSandbox(USER))?.state === 'stopped') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('等待停机超时');
}

const SKILL: SkillDef = {
  name: 'e2e-hello',
  description: 'e2e test skill',
  kind: 'builtin',
  source: 'builtin',
  enabled: true,
  files: {
    'SKILL.md':
      '---\nname: e2e-hello\ndescription: e2e test skill\n---\nRun ./scripts/hello.py',
    'scripts/hello.py': 'import sys\nprint("hello from", sys.argv[1])\n',
  },
};

// 1x1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function main() {
  console.log(`provider=${provider.name} user=${USER}\n`);
  assert.ok(provider.isConfigured(), `${provider.name} 凭据未配置`);

  const before = await pickUserSandbox(USER);
  const sb = await getUserSandbox(USER);
  assert.ok(sb, 'getUserSandbox 返回 null');
  const sandboxId = sb.id;

  try {
    await step(
      before
        ? 'getUserSandbox 复用已有测试沙箱'
        : 'getUserSandbox 新建测试沙箱',
      async () => {
        if (before) assert.equal(sandboxId, before.id, '没有复用已有沙箱');
        const ws = await sb.getWorkDir();
        assert.match(ws, /\/agent-workspace$/);
        const l = await pickUserSandbox(USER);
        assert.equal(l?.id, sandboxId);
        assert.equal(l?.state, 'started');
        // 清掉上一轮的测试产物文件（只删工作区 out/，沙箱本身保留）
        await sb.execute('rm -rf out');
        return `id=${sandboxId} ws=${ws} ${before ? `复用（原状态 ${before.state}）` : '新建'}`;
      },
    );

    await step('技能上传：落到 /skills，且同内容第二次跳过', async () => {
      await uploadSkillsToSandbox(sb, [SKILL]);
      const ls = await sb.ls('/skills/e2e-hello');
      const names = (ls.files ?? []).map((f) => f.path);
      assert.ok(names.includes('/skills/e2e-hello/SKILL.md'), String(names));
      // 第二次：指纹一致应跳过 rm -rf，故先放一个标记文件，跳过时它会保留
      await sb.execute('touch skills/.marker');
      await uploadSkillsToSandbox(sb, [SKILL]);
      const marker = await sb.execute('test -f skills/.marker && echo kept');
      assert.match(marker.output, /kept/);
    });

    await step(
      '文件工具 write/read/edit/ls/glob/grep（虚拟根 /）',
      async () => {
        const w = await sb.write('/out/hello.txt', 'hello world\nline2\n');
        assert.ok(!w.error, w.error);
        const e = await sb.edit('/out/hello.txt', 'world', 'e2b');
        assert.ok(!e.error, e.error);
        const r = await sb.read('/out/hello.txt');
        assert.ok(
          typeof r.content === 'string' && r.content.includes('hello e2b'),
        );
        const ls = await sb.ls('/');
        assert.ok(
          (ls.files ?? []).some((f) => f.path === '/out/'),
          'ls / 缺 out/',
        );
        const g = await sb.glob('**/*.txt');
        assert.ok(
          (g.files ?? []).some((f) => f.path.endsWith('out/hello.txt')),
        );
        const gr = await sb.grep('hello e2b');
        assert.ok((gr.matches ?? []).some((m) => m.path === '/out/hello.txt'));
        // 真实路径不外泄
        assert.ok(!JSON.stringify(ls).includes('/agent-workspace'));
      },
    );

    await step('execute：在工作区运行技能脚本，输出脱敏', async () => {
      // execute 只锚定 cwd、不做虚拟路径映射：技能脚本须用工作区相对路径 skills/...
      //（/skills/... 绝对路径在 Daytona 与 E2B 上都找不到，属既有行为）
      const r = await sb.execute(
        'python3 skills/e2e-hello/scripts/hello.py e2e > out/py.txt && cat out/py.txt && pwd',
      );
      assert.equal(r.exitCode, 0, r.output);
      assert.match(r.output, /hello from e2e/);
      assert.ok(!r.output.includes('/agent-workspace'), r.output);
      return JSON.stringify(r.output);
    });

    await step('execute：非零退出码与 stderr 原样返回（不抛错）', async () => {
      const r = await sb.execute('echo oops >&2; exit 7');
      assert.equal(r.exitCode, 7);
      assert.match(r.output, /oops/);
    });

    await step('/skills 只读、../ 逃逸被拒', async () => {
      assert.ok((await sb.write('/skills/x.md', 'x')).error);
      assert.ok((await sb.read('../../etc/passwd')).error);
    });

    await step('工作区列举 / 目录树 / 预览（文本+图片）', async () => {
      await sb.uploadFiles([['/out/dot.png', new Uint8Array(PNG)]]);
      const files = (await listWorkspaceFiles(sb)).map((f) => f.path).sort();
      assert.deepEqual(files, ['out/dot.png', 'out/hello.txt', 'out/py.txt']);
      const dir = await listDir(sb, 'out');
      assert.equal(dir.length, 3);
      const txt = await readFilePreview(sb, 'out/py.txt');
      assert.equal(txt.kind, 'text');
      const img = await readFilePreview(sb, 'out/dot.png');
      assert.equal(img.kind, 'image');
      assert.ok(
        img.kind === 'image' && img.dataUrl.endsWith(PNG.toString('base64')),
      );
      return files.join(', ');
    });

    await step('状态接口：provider/能力/文件', async () => {
      const s = await status.status(USER, true);
      assert.equal(s.exists, true);
      assert.equal(s.provider, provider.name);
      assert.equal(s.desktopSupported, provider.name === 'daytona');
      assert.equal(s.state, 'started');
      assert.equal(s.files?.length, 3);
      return JSON.stringify({ ...s, files: s.files?.length });
    });

    if (provider.name === 'e2b') {
      await step('E2B 不支持桌面：startUserDesktop → null', async () => {
        assert.equal(await startUserDesktop(USER), null);
      });
    }

    await step(
      '停机（模拟闲置到期）后状态为 stopped，且状态查询不唤醒',
      async () => {
        await stopRemote(sandboxId);
        const s1 = await status.status(USER, true);
        assert.equal(s1.state, 'stopped');
        assert.equal(s1.files, null);
        const s2 = await status.status(USER);
        assert.equal(s2.state, 'stopped', '状态查询把沙箱唤醒了');
      },
    );

    await step(
      '文件接口 findUserSandbox 唤醒沙箱，停机前的文件仍在',
      async () => {
        const again = await findUserSandbox(USER);
        assert.ok(again, 'findUserSandbox 返回 null');
        assert.equal(again.id, sandboxId);
        const r = await again.read('/out/hello.txt');
        assert.ok(
          typeof r.content === 'string' && r.content.includes('hello e2b'),
        );
        assert.equal((await pickUserSandbox(USER))?.state, 'started');
      },
    );

    await step('再次 getUserSandbox 复用同一沙箱（不裂变）', async () => {
      const again = await getUserSandbox(USER);
      assert.equal(again?.id, sandboxId);
      const all = await provider.listUserSandboxes(USER);
      assert.equal(all.length, 1);
    });
  } finally {
    console.log(
      `\n📦 保留测试沙箱 ${sandboxId}（不删除，按闲置策略自动停机/暂停）`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
