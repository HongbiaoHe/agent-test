/**
 * 沙箱后台命令的三段 shell 脚本（纯函数，便于单测）。都经 GuardedSandbox.execute 执行，
 * cwd 已锚定在工作区（/workspace），所以状态目录用相对路径 `.bg/<taskId>/`：
 *   cmd.sh 命令原文 · out.log 合并输出 · pid 进程组 id · exit 退出码（存在 = 已结束）
 *
 * 关键点：
 * - 命令原文 base64 传入再解码落盘，不拼进 shell 字符串，免转义 / 注入问题；
 * - setsid 起新会话，`bash -c` 里 `echo $$` 记下的就是进程组 id，取消时 kill 整组（含子进程）；
 * - 所有 fd 重定向到文件 / /dev/null：E2B 的 commands.run 会等 stdout 关闭才返回，
 *   不断开的话启动命令会被后台进程一直拖住（见 memory e2b-sandbox-provider-facts）。
 */
const ID_RE = /^[a-z0-9]+$/i;

function dir(taskId: string): string {
  if (!ID_RE.test(taskId)) throw new Error(`invalid task id ${taskId}`);
  return `.bg/${taskId}`;
}

export function startScript(taskId: string, command: string): string {
  const d = dir(taskId);
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  const runner = `bash "$0/cmd.sh" > "$0/out.log" 2>&1; echo $? > "$0/exit"`;
  // 按行拼：后台的 `&` 本身就是命令终止符，不能再跟 `&&`。
  // pid 由这里同步写（$!）：setsid / nohup 都是 exec 链，$! 就是 runner bash 的 pid；
  // 若交给后台进程自己写，启动后立刻查状态会因 pid 文件还没出现而误判 LOST。
  return [
    `mkdir -p ${d} && printf '%s' '${b64}' | base64 -d > ${d}/cmd.sh || exit 1`,
    `S=$(command -v setsid || true)`,
    `$S nohup bash -c '${runner}' ${d} > /dev/null 2>&1 < /dev/null &`,
    `echo $! > ${d}/pid`,
    `echo started`,
  ].join('\n');
}

export function checkScript(taskId: string): string {
  const d = dir(taskId);
  return [
    `if [ -f ${d}/exit ]; then echo "EXIT:$(cat ${d}/exit)"; tail -c 4000 ${d}/out.log 2>/dev/null;`,
    `elif [ -f ${d}/pid ] && kill -0 "$(cat ${d}/pid)" 2>/dev/null; then echo RUNNING;`,
    `else echo LOST; tail -c 2000 ${d}/out.log 2>/dev/null; fi; true`,
  ].join(' ');
}

/**
 * 递归杀整棵进程树，再补一刀进程组：没有 setsid 的环境里不存在独立进程组，
 * 只杀 runner bash 会留下孤儿孙进程（实测 `bash cmd.sh` 下的 sleep 残留）。
 */
export function cancelScript(taskId: string): string {
  const d = dir(taskId);
  return [
    `kt() { for c in $(pgrep -P "$1" 2>/dev/null); do kt "$c"; done; kill -TERM "$1" 2>/dev/null; }`,
    `p=$(cat ${d}/pid 2>/dev/null)`,
    `if [ -n "$p" ]; then kt "$p"; kill -TERM -- -"$p" 2>/dev/null; fi`,
    `echo cancelled`,
  ].join('\n');
}

export type CheckState =
  | { state: 'running' }
  | { state: 'exited'; exitCode: number; log: string }
  /** 没有退出码、进程也不在了：沙箱停过机 / 被外部杀掉 */
  | { state: 'lost'; log: string };

export function parseCheck(output: string): CheckState {
  const text = output.replace(/\r/g, '');
  const firstLine = text.split('\n', 1)[0].trim();
  const rest = text.slice(text.indexOf('\n') + 1);
  const m = /^EXIT:(-?\d+)$/.exec(firstLine);
  if (m) {
    return {
      state: 'exited',
      exitCode: Number(m[1]),
      log: text.includes('\n') ? rest : '',
    };
  }
  if (firstLine === 'RUNNING') return { state: 'running' };
  return { state: 'lost', log: text.includes('\n') ? rest : '' };
}
