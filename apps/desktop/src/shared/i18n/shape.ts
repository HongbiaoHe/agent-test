/**
 * 译文的形状约束：以简体中文字典为准，其他语言必须有同样的键（值是任意字符串）。
 * 中文没有单复数，英文可以多写 `xxx_one`（i18next 按 count 选 `_one` / `_other`），所以放行 `_one` 后缀的键。
 */
export type MessageShape<T> = {
  [K in keyof T]: T[K] extends string ? string : MessageShape<T[K]>;
} & { [plural: `${string}_one`]: string };
