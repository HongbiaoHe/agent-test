// 纯判定逻辑，无 I/O，便于单测。被 scripts/dev.mjs 调用。

// 启动期日志错误标记（best-effort）：next dev / nest watch 编译报错时进程不崩，
// 只能靠扫日志抓。刻意排除泛化的 "Error:" 以免误杀正常启动日志。
export const ERROR_MARKERS = [
  'Failed to compile',
  'Module not found',
  'Cannot find module',
  // 只匹配 N≥1 的编译错误；nest --watch 成功时打 "Found 0 errors." 不能误报。
  /Found [1-9]\d* error/,
];

export function scanLogForErrors(text) {
  if (!text) return null;
  for (const m of ERROR_MARKERS) {
    if (typeof m === 'string') {
      if (text.includes(m)) return m;
    } else if (m.test(text)) {
      return m.source;
    }
  }
  return null;
}

// apps: `pm2 jlist` 结果；baseline: Map<name, 启动时 restart_time>
export function evaluatePm2Status(apps, baseline) {
  const failures = [];
  for (const app of apps) {
    const env = app.pm2_env ?? {};
    const status = env.status;
    const restarts = env.restart_time ?? 0;
    const base = baseline.get(app.name) ?? 0;
    if (status === 'errored' || status === 'stopped') {
      failures.push({ name: app.name, reason: `进程状态 ${status}` });
    } else if (restarts > base) {
      failures.push({ name: app.name, reason: `启动后崩溃重启 ${restarts - base} 次` });
    }
  }
  return failures;
}

// 单帧快照 → 决策。input: { apps, baseline, ports:{name:bool}, logs:{name:string} }
export function evaluateTick({ apps, baseline, ports, logs }) {
  const failures = evaluatePm2Status(apps, baseline);
  for (const [name, text] of Object.entries(logs ?? {})) {
    const hit = scanLogForErrors(text);
    if (hit) failures.push({ name, reason: `日志命中错误标记: ${hit}` });
  }
  if (failures.length) return { decision: 'failed', failures };
  const allPortsUp = ports && Object.values(ports).length > 0
    && Object.values(ports).every(Boolean);
  return { decision: allPortsUp ? 'ready' : 'pending', failures: [] };
}
