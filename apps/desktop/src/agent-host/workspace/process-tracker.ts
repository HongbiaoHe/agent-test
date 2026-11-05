/**
 * 正在执行的命令登记表：agent-host 崩溃 / 被强杀时没机会 stop()，而每条命令都在独立进程组里（detached），
 * 不清理就会成为孤儿一直跑下去。这里把每条命令的进程组 id 与完整命令行记进 SQLite，结束时删掉；
 * agent-host 启动时 reapOrphans() 清理上次残留的。
 *
 * 防误杀：pid 可能已被系统复用给别的程序，所以只有 `ps` 查到的当前命令行与登记的**完全一致**时才杀。
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { Db } from '../db/database';

const row = z.object({ pgid: z.number(), command: z.string() });

export class ProcessTracker {
  constructor(private readonly db: Db) {}

  add(pgid: number, commandLine: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO running_process (pgid, command, started_at) VALUES (?, ?, ?)')
      .run(pgid, commandLine, Date.now());
  }

  remove(pgid: number): void {
    this.db.prepare('DELETE FROM running_process WHERE pgid = ?').run(pgid);
  }

  /** 清理上次残留的命令进程组；返回实际杀掉的数量 */
  reapOrphans(): number {
    const rows = this.db
      .prepare('SELECT pgid, command FROM running_process')
      .all()
      .map((r) => row.parse(r));
    let killed = 0;
    for (const r of rows) {
      if (currentCommand(r.pgid) === r.command) {
        try {
          process.kill(-r.pgid, 'SIGKILL');
          killed++;
        } catch {
          // 已经退出
        }
      }
      this.remove(r.pgid);
    }
    return killed;
  }
}

/** 该 pid 当前的完整命令行（-ww 不截断）；进程不存在返回 null */
function currentCommand(pid: number): string | null {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
