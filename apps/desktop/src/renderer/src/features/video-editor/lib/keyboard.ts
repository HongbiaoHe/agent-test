/** 快捷键的焦点判断：在输入框 / 文本域 / 下拉 / 可编辑区 / 弹窗里时，不拦截空格与撤销重做 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('input, textarea, select, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')) return true;
  return false;
}
