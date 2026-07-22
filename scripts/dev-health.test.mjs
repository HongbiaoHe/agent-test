import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanLogForErrors,
  evaluatePm2Status,
  evaluateTick,
} from './dev-health.mjs';

test('scanLogForErrors 命中前端编译错误', () => {
  assert.equal(scanLogForErrors('xxx\nFailed to compile\nyyy'), 'Failed to compile');
  assert.equal(scanLogForErrors("Found 3 error(s)."), 'Found [1-9]\\d* error');
});

test('scanLogForErrors 干净日志返回 null', () => {
  assert.equal(scanLogForErrors('Ready in 1200ms\nNest application successfully started'), null);
  // nest --watch 启动成功的标志，绝不能误报
  assert.equal(scanLogForErrors('Found 0 errors. Watching for file changes.'), null);
  assert.equal(scanLogForErrors(''), null);
});

test('evaluatePm2Status: errored / 崩溃重启 / 正常', () => {
  const baseline = new Map([['backend', 0], ['frontend', 0]]);
  const errored = [{ name: 'backend', pm2_env: { status: 'errored', restart_time: 0 } }];
  assert.equal(evaluatePm2Status(errored, baseline).length, 1);

  const crashed = [{ name: 'frontend', pm2_env: { status: 'online', restart_time: 3 } }];
  assert.equal(evaluatePm2Status(crashed, baseline)[0].name, 'frontend');

  const healthy = [{ name: 'backend', pm2_env: { status: 'online', restart_time: 0 } }];
  assert.equal(evaluatePm2Status(healthy, baseline).length, 0);
});

test('evaluateTick: 失败 / ready / pending', () => {
  const baseline = new Map([['backend', 0], ['frontend', 0]]);
  const onlineApps = [
    { name: 'backend', pm2_env: { status: 'online', restart_time: 0 } },
    { name: 'frontend', pm2_env: { status: 'online', restart_time: 0 } },
  ];

  const failed = evaluateTick({
    apps: onlineApps, baseline,
    ports: { backend: true, frontend: true },
    logs: { backend: '', frontend: 'Module not found' },
  });
  assert.equal(failed.decision, 'failed');
  assert.equal(failed.failures[0].name, 'frontend');

  const ready = evaluateTick({
    apps: onlineApps, baseline,
    ports: { backend: true, frontend: true },
    logs: { backend: '', frontend: '' },
  });
  assert.equal(ready.decision, 'ready');

  const pending = evaluateTick({
    apps: onlineApps, baseline,
    ports: { backend: true, frontend: false },
    logs: { backend: '', frontend: '' },
  });
  assert.equal(pending.decision, 'pending');
});
