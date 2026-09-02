"use client";

import { useContext, useEffect, useRef, useState } from "react";

import { CanvasEditorContext, type NodeContentPatch } from "../_components/flow-canvas";

/** 输入停止后自动保存的防抖时长（失焦会立即收口，不必等它）。 */
const DEBOUNCE_MS = 600;

/**
 * 一个节点字段的本地草稿 + 防抖/失焦自动保存。
 *
 * 卡面上的就地编辑（node-inline-field）与移动端抽屉（node-editor-drawer）共用这一份：
 * 两端改的是同一个字段，保存时机与「值没变就不发 op」的判断必须一致。
 *
 * 外部值变化（agent 改了同一节点、或 409 重拉快照）时同步草稿，避免显示过期内容——
 * 但正在输入时不同步，否则会把用户没打完的字覆盖掉。
 */
export function useDraftField(
  nodeId: string,
  field: keyof NodeContentPatch,
  value: string,
) {
  const { updateNode, markSaving, cancelSaving } =
    useContext(CanvasEditorContext);
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 已提交（或外部同步到）的值：作为「是否变化」的比较基准，避免重复发同一 op
  const committed = useRef(value);
  // 是否正在输入：输入期不接受外部同步
  const typing = useRef(false);

  useEffect(() => {
    if (typing.current) return;
    committed.current = value;
    setDraft(value);
  }, [value]);

  function commit(text: string) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // 内容回退到原值：没有 op 要发，撤销键入时点亮的 loading
    if (text === committed.current) {
      cancelSaving(nodeId);
      return;
    }
    committed.current = text;
    updateNode(nodeId, { [field]: text });
  }

  function onChange(text: string) {
    typing.current = true;
    setDraft(text);
    // 键入即亮 loading（不等 600ms 防抖到点发请求）——「触发就开始，直至保存成功」
    markSaving(nodeId);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(text), DEBOUNCE_MS);
  }

  function finish() {
    typing.current = false;
    commit(draft);
  }

  // 卸载时把还没到点的改动提交掉。卡面编辑是「点别处就退出编辑态」，
  // 退出即卸载 textarea，此时防抖若只是被清掉，最后几个字就没了，
  // 保存指示还会永远停在 saving（markSaving 已点亮却没有对应的收口）。
  // commit 挂 ref 上取最新的闭包，effect 本身只在卸载时跑一次。
  const pending = useRef<() => void>(() => {});
  // 每次渲染后把最新闭包挂上去（渲染期改 ref 是 react-hooks/refs 明令禁止的）
  useEffect(() => {
    pending.current = () => {
      if (timer.current) commit(draft);
    };
  });
  useEffect(() => () => pending.current(), []);

  return { draft, onChange, finish };
}
