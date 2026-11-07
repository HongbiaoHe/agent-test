/**
 * 字幕排版：预览（DOM 叠加）与导出（libass 烧录）共用的一套尺寸与断行，保证两边观感一致。
 *
 * - 尺寸都按画布高等比：字号 = 高 5%（CSS 字号，即 1em），描边 = 高 0.4%（至少 1），边距 = 高 6%，
 *   bottom-box 的底框内边距 = 字号 × 0.25。预览按预览画布的实际像素高换算，导出按输出尺寸换算。
 * - 断行不交给渲染端各自做：导出用的 libass 没编 libunibreak，只会在空格处折行，中文整句会冲出画面；
 *   浏览器又是另一套规则。所以由剪辑器用同一字体量宽、按 wrapSubtitle 断好行，预览与导出都按这些行渲染
 *   （导出时 ASS 用 WrapStyle 2 关掉 libass 的自动折行）。
 * - 字号换算：libass 把 ASS 的 Fontsize 当作字体 (winAscent + winDescent) 的像素高，不是 em；
 *   PingFang 的该值是 1400/1000 em，所以 ASS Fontsize = CSS 字号 × SUBTITLE_FONT_HEIGHT_EM，行距也正好是它，
 *   预览的 line-height 取同一个值。
 */
import type { SubtitleStyle } from './project';

/** 字幕字体：macOS 自带；预览与导出用同一个，量宽才准 */
export const SUBTITLE_FONT_FAMILY = 'PingFang SC';
/** PingFang 的 (winAscent + winDescent) / unitsPerEm = (1060 + 340) / 1000，也是它的 hhea 行高 */
export const SUBTITLE_FONT_HEIGHT_EM = 1.4;

export interface SubtitleLayout {
  position: 'top' | 'bottom';
  /** 半透明黑底框（bottom-box） */
  box: boolean;
  /** CSS 字号（1em 的像素） */
  fontSize: number;
  /** 描边宽度（画在字形外侧） */
  outline: number;
  /** 上 / 下 / 左 / 右边距 */
  margin: number;
  boxPadding: number;
  /** 一行文字最多多宽（画布宽减两侧边距，带底框时再减两侧内边距） */
  maxLineWidth: number;
}

export function subtitleLayout(style: SubtitleStyle, canvas: { width: number; height: number }): SubtitleLayout {
  const fontSize = canvas.height * 0.05;
  const box = style === 'bottom-box';
  const margin = canvas.height * 0.06;
  const boxPadding = fontSize * 0.25;
  return {
    position: style === 'top' ? 'top' : 'bottom',
    box,
    fontSize,
    outline: box ? 0 : Math.max(1, canvas.height * 0.004),
    margin,
    boxPadding,
    maxLineWidth: Math.max(fontSize, canvas.width - 2 * margin - (box ? 2 * boxPadding : 0)),
  };
}

/** 不能出现在行首的标点（粘到前一个字后面） */
const NO_LINE_START = new Set([...'，。、！？；：）」』”’》〉】…—～,.!?;:)]}%']);
/** 不能出现在行尾的标点（粘到后一个字前面） */
const NO_LINE_END = new Set([...'（「『“‘《〈【([{']);
/** 每个字之间都能断开的文字：CJK 汉字 / 假名 / 谚文 / 全角符号 */
const BREAK_ANYWHERE = /[⺀-鿿가-힯豈-﫿＀-￯]/u;

/** 切成不可再分的单元：CJK 每字一个、其他文字按词、空白单独一个；避头尾标点并进相邻单元 */
function units(paragraph: string): string[] {
  const raw: string[] = [];
  let word = '';
  const flush = () => {
    if (word) raw.push(word);
    word = '';
  };
  for (const ch of paragraph) {
    if (/\s/u.test(ch)) {
      flush();
      raw.push(ch);
    } else if (BREAK_ANYWHERE.test(ch) || NO_LINE_START.has(ch) || NO_LINE_END.has(ch)) {
      flush();
      raw.push(ch);
    } else {
      word += ch;
    }
  }
  flush();
  const out: string[] = [];
  let carry = '';
  for (const u of raw) {
    const first = [...u][0] ?? '';
    if (NO_LINE_START.has(first) && out.length && !/\s/u.test(out[out.length - 1] ?? '')) {
      out[out.length - 1] += u;
    } else if (NO_LINE_END.has(u)) {
      carry += u;
    } else {
      out.push(carry + u);
      carry = '';
    }
  }
  if (carry) out.push(carry);
  return out;
}

/** 把超宽的单元按字拆成若干段，每段不超过 maxWidth（单个字本身超宽时独占一段） */
function splitWide(unit: string, maxWidth: number, measure: (s: string) => number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of unit) {
    if (cur && measure(cur + ch) > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * 按宽度断行（贪心：一行能放下就继续放）。手动换行（\n）保留；行首行尾的空白去掉；
 * 中文每字之间可断，英文按词断，单词本身超宽时按字拆；避头尾标点不落单。
 * measure 返回一段文字在目标字号下的像素宽。
 */
export function wrapSubtitle(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    const push = () => {
      lines.push(line.trimEnd());
      line = '';
    };
    for (const unit of units(paragraph)) {
      if (!line && /^\s+$/u.test(unit)) continue;
      if (measure((line + unit).trimEnd()) <= maxWidth) {
        line += unit;
        continue;
      }
      if (/^\s+$/u.test(unit)) {
        push();
        continue;
      }
      if (line.trim()) push();
      else line = '';
      if (measure(unit) <= maxWidth) {
        line = unit;
        continue;
      }
      const parts = splitWide(unit, maxWidth, measure);
      for (const p of parts.slice(0, -1)) {
        line = p;
        push();
      }
      line = parts[parts.length - 1] ?? '';
    }
    push();
  }
  return lines;
}
