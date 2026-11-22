/**
 * 在途的 MCP 工具调用，按 key（授权 | 客户端 IP | JSON-RPC 请求 id）登记各自的中止开关。
 *
 * 无状态部署下每个 HTTP 请求各建一个 McpServer，客户端取消调用时另发一条
 * notifications/cancelled（并不断开原连接），SDK 在新 server 里找不到原请求，只能在这里接上。
 * 只在本进程内有效：多实例部署时取消可能落到别的实例，届时原调用照常跑完。
 *
 * 各客户端的请求 id 都从 0 数起，同一授权在同一出口 IP 下有两个客户端并发时 key 会撞：
 * 这时认不出取消的是哪一个，宁可谁都不停（原调用照常跑完），也不去停别人的调用。
 */
export class InflightCalls {
  private readonly byKey = new Map<string, Set<AbortController>>();

  register(keys: readonly string[], ctrl: AbortController): void {
    for (const k of keys) {
      const owners = this.byKey.get(k) ?? new Set<AbortController>();
      owners.add(ctrl);
      this.byKey.set(k, owners);
    }
  }

  release(keys: readonly string[], ctrl: AbortController): void {
    for (const k of keys) {
      const owners = this.byKey.get(k);
      owners?.delete(ctrl);
      if (owners?.size === 0) this.byKey.delete(k);
    }
  }

  /** 取消这个 key 的调用；没有登记、或有歧义（撞号）时什么都不做。返回是否真的取消了 */
  cancel(key: string): boolean {
    const owners = this.byKey.get(key);
    if (owners?.size !== 1) return false;
    owners.forEach((c) => c.abort());
    return true;
  }
}
