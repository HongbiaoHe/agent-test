"use client";

import {
  type DesignDocument,
  fontInfo,
  googleFontCssUrl,
  nearestFontWeight,
} from "@agent-test/design-schema";

/**
 * 白名单字体的按需加载（问题 5）：用到哪款才插一条 Google Fonts CSS2 的 <link>，
 * 再用 document.fonts.load 等字形真正到位——Konva 必须在字体就绪后再画，否则先用默认字体画、
 * 宽高也量错。中文字体由 Google 按 unicode-range 切片，load 时带上实际文案只拉用到的字。
 */

const linked = new Set<string>();

function ensureLink(family: string) {
  if (linked.has(family) || typeof document === "undefined") return;
  linked.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = googleFontCssUrl(family);
  document.head.appendChild(link);
}

/** 等某款字体的某个字重就绪（sample = 实际要显示的文字，决定拉哪些 unicode 切片）。 */
export async function loadFont(family: string, weight = 400, sample = "Aa中文") {
  if (!fontInfo(family)) return;
  ensureLink(family);
  const w = nearestFontWeight(family, weight);
  try {
    await document.fonts.load(`${w} 32px "${family}"`, sample);
  } catch {
    // 字体拿不到不阻塞编辑：退回系统字体显示
  }
}

/** 文档里所有文字图层用到的字体全部就绪。 */
export async function loadDocumentFonts(doc: DesignDocument) {
  await Promise.all(
    doc.layers.flatMap((l) =>
      l.type === "text" ? [loadFont(l.fontFamily, l.fontWeight, l.text || "Aa")] : [],
    ),
  );
}
