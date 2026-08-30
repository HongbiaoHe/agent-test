"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * 是否已水合。SSR 与首个客户端渲染都返回 false，水合后 React 会因快照不一致补一次渲染
 * 返回 true——同 use-is-mobile / use-panel-collapsed 的范式，不在 effect 里 setState
 * （Next16 的 react-hooks/set-state-in-effect 是 error 级）。
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function read<T>(key: string, fallback: T, parse: (raw: unknown) => T | null): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(JSON.parse(raw) as unknown) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 持久化到 localStorage 的本地状态。
 *
 * SSR 首帧一律用 fallback（与服务端一致，不会水合失配），水合后读缓存值；此后以本次
 * 会话内的改动为准。`fallback` 与 `parse` 必须是稳定引用（模块常量 / useCallback），
 * 否则 useMemo 每帧重算。
 */
export function useStoredState<T>(
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | null,
): [T, (next: T) => void] {
  const hydrated = useHydrated();
  // 用 { value } 包一层：T 本身可能是 null/false，直接判空会把合法值当"未改过"
  const [local, setLocal] = useState<{ value: T } | null>(null);
  const stored = useMemo(
    () => (hydrated ? read(key, fallback, parse) : fallback),
    [hydrated, key, fallback, parse],
  );

  const set = useCallback(
    (next: T) => {
      setLocal({ value: next });
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // 隐私模式 / 配额满：内存态照常生效，只是不跨刷新
      }
    },
    [key],
  );

  return [local ? local.value : stored, set];
}

const parseBoolean = (raw: unknown): boolean | null =>
  typeof raw === "boolean" ? raw : null;

/** useStoredState 的布尔特化（面板的展开 / 钉住等开关）。 */
export function useStoredFlag(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  return useStoredState(key, fallback, parseBoolean);
}
