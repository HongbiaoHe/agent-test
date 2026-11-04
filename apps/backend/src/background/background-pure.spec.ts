import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelScript,
  checkScript,
  parseCheck,
  startScript,
} from './sandbox-command';
import { evaluateWatch, readPath } from './watch-condition';

describe('evaluateWatch', () => {
  const done = ['completed'];
  const fail = ['failed'];

  it('优先读 structuredContent', () => {
    expect(
      evaluateWatch(
        { content: [], structuredContent: { status: 'completed' } },
        'status',
        done,
        fail,
      ),
    ).toEqual({ outcome: 'done', value: 'completed' });
  });

  it('没有 structuredContent 时把文本当 JSON 解析；支持数组下标', () => {
    const r = {
      content: [
        { type: 'text' as const, text: '{"tasks":[{"status":"failed"}]}' },
      ],
    };
    expect(evaluateWatch(r, 'tasks.0.status', done, fail)).toEqual({
      outcome: 'failed',
      value: 'failed',
    });
  });

  it('字段还没出现 / 中间状态 → pending；非 JSON 文本 → pending', () => {
    expect(
      evaluateWatch(
        { content: [], structuredContent: {} },
        'status',
        done,
        fail,
      ).outcome,
    ).toBe('pending');
    expect(
      evaluateWatch(
        { content: [], structuredContent: { status: 'generating' } },
        'status',
        done,
        fail,
      ),
    ).toEqual({ outcome: 'pending', value: 'generating' });
    expect(
      evaluateWatch(
        { content: [{ type: 'text', text: 'not json' }] },
        'status',
        done,
        fail,
      ).outcome,
    ).toBe('pending');
  });

  it('布尔 / 数字值按字符串比较；对象值不参与匹配', () => {
    expect(
      evaluateWatch(
        { content: [], structuredContent: { ready: true } },
        'ready',
        ['true'],
        [],
      ).outcome,
    ).toBe('done');
    expect(readPath({ a: { b: [1, 2] } }, 'a.b.1')).toBe(2);
    expect(
      evaluateWatch(
        { content: [], structuredContent: { status: { x: 1 } } },
        'status',
        done,
        fail,
      ).outcome,
    ).toBe('pending');
  });
});

describe('sandbox-command', () => {
  it('parseCheck 三种状态', () => {
    expect(parseCheck('RUNNING\n')).toEqual({ state: 'running' });
    expect(parseCheck('EXIT:2\nboom\n')).toEqual({
      state: 'exited',
      exitCode: 2,
      log: 'boom\n',
    });
    expect(parseCheck('EXIT:0')).toEqual({
      state: 'exited',
      exitCode: 0,
      log: '',
    });
    expect(parseCheck('LOST\npartial')).toEqual({
      state: 'lost',
      log: 'partial',
    });
  });

  it('命令原文 base64 传入（不拼进 shell）；非法 taskId 拒绝', () => {
    const s = startScript('abc123', "rm -rf / ; echo 'x' $(whoami)");
    expect(s).not.toContain('whoami');
    expect(s).toContain(
      Buffer.from("rm -rf / ; echo 'x' $(whoami)").toString('base64'),
    );
    expect(() => startScript('../etc', 'ls')).toThrow(/invalid task id/);
    expect(() => checkScript('a b')).toThrow();
  });

  describe('在真实 bash 里跑（与沙箱同一套脚本）', () => {
    let cwd: string;
    const run = (script: string) =>
      execSync(`( ${script} )`, { cwd, shell: '/bin/bash', encoding: 'utf8' });
    const until = (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) execSync('sleep 0.1');
    };

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'bg-'));
    });
    afterEach(() => rmSync(cwd, { recursive: true, force: true }));

    it('启动立刻返回、跑完拿到退出码与输出', () => {
      expect(
        run(startScript('t1', 'echo "a b" && echo c >&2; exit 3')).trim(),
      ).toBe('started');
      until(() => parseCheck(run(checkScript('t1'))).state === 'exited');
      expect(parseCheck(run(checkScript('t1')))).toEqual({
        state: 'exited',
        exitCode: 3,
        log: 'a b\nc\n',
      });
    });

    it('刚启动就查是 running（不误判 lost）；取消后整棵进程树都被杀掉', () => {
      run(startScript('t2', 'sleep 47; echo never'));
      expect(parseCheck(run(checkScript('t2'))).state).toBe('running');
      run(cancelScript('t2'));
      until(() => parseCheck(run(checkScript('t2'))).state !== 'running');
      expect(parseCheck(run(checkScript('t2'))).state).toBe('lost');
      const left = execSync("ps -axo command | grep -c '^sleep 47' || true", {
        encoding: 'utf8',
      }).trim();
      expect(left).toBe('0');
    });
  });
});
