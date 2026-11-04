/**
 * 字体白名单（单一事实来源）：文字图层的 fontFamily 只能取这里的值。
 *
 * 为什么必须是受控清单：Konva 在 canvas 上画字，字体没加载完就会先用默认字体画、宽高也算错；
 * 导出与后端渲染同样依赖「这款字体一定拿得到」。全部取自 Google Fonts（前端 CSS2 API 按需加载，
 * 后端下载 TTF 注册给渲染器），family 即 Google Fonts 的族名。
 *
 * mood 给 agent 挑字体用（「粗犷标题」「优雅衬线」），也作属性面板下拉里的副标题。
 */
export const FONT_CATALOG = [
  // —— 中文（简）——
  { family: 'Noto Sans SC', label: '思源黑体', script: 'zh', category: 'sans', weights: [300, 400, 500, 700, 900], mood: '现代中性黑体，正文与标题通用' },
  { family: 'Noto Serif SC', label: '思源宋体', script: 'zh', category: 'serif', weights: [400, 500, 700, 900], mood: '典雅宋体，适合高级感、文化、美妆标题' },
  { family: 'ZCOOL KuaiLe', label: '站酷快乐体', script: 'zh', category: 'display', weights: [400], mood: '圆润俏皮，童趣、零食、促销' },
  { family: 'ZCOOL QingKe HuangYou', label: '站酷庆科黄油体', script: 'zh', category: 'display', weights: [400], mood: '粗壮方正，大促、冲击力标题' },
  { family: 'ZCOOL XiaoWei', label: '站酷小薇体', script: 'zh', category: 'serif', weights: [400], mood: '清秀文艺宋体，生活方式、茶饮' },
  { family: 'Ma Shan Zheng', label: '马善政毛笔', script: 'zh', category: 'handwriting', weights: [400], mood: '毛笔书法，国潮、节日、东方意境' },
  { family: 'Long Cang', label: '龙藏体', script: 'zh', category: 'handwriting', weights: [400], mood: '随性手写行书，手作、温度感' },
  // —— 中文（繁）——
  { family: 'Noto Sans TC', label: '思源黑體（繁）', script: 'zh-hant', category: 'sans', weights: [300, 400, 500, 700, 900], mood: '繁体现代黑体，港台受众正文与标题' },
  { family: 'Noto Serif TC', label: '思源宋體（繁）', script: 'zh-hant', category: 'serif', weights: [400, 500, 700, 900], mood: '繁体典雅宋体，高级感标题' },
  { family: 'LXGW WenKai TC', label: '霞鶩文楷（繁）', script: 'zh-hant', category: 'handwriting', weights: [300, 400, 700], mood: '楷体书卷气，文艺、书店、手帐' },
  // —— 拉丁 ——
  { family: 'Inter', label: 'Inter', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700, 800, 900], mood: '干净的界面无衬线，信息与说明文字' },
  { family: 'Montserrat', label: 'Montserrat', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700, 800, 900], mood: '几何无衬线，品牌与时尚标题' },
  { family: 'Poppins', label: 'Poppins', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700, 800, 900], mood: '圆润几何，友好、科技、App 推广' },
  { family: 'Syne', label: 'Syne', script: 'latin', category: 'sans', weights: [400, 500, 600, 700, 800], mood: '前卫艺术感，展览、潮流品牌' },
  { family: 'Oswald', label: 'Oswald', script: 'latin', category: 'display', weights: [300, 400, 500, 600, 700], mood: '窄体粗标题，运动、新闻感' },
  { family: 'Bebas Neue', label: 'Bebas Neue', script: 'latin', category: 'display', weights: [400], mood: '全大写窄体，海报大标题、价格' },
  { family: 'Anton', label: 'Anton', script: 'latin', category: 'display', weights: [400], mood: '超粗窄体，强冲击促销标题' },
  { family: 'Archivo Black', label: 'Archivo Black', script: 'latin', category: 'display', weights: [400], mood: '厚重无衬线，街头、球鞋、潮牌' },
  { family: 'Playfair Display', label: 'Playfair Display', script: 'latin', category: 'serif', weights: [400, 500, 600, 700, 800, 900], mood: '高对比衬线，奢侈品、杂志封面' },
  { family: 'DM Serif Display', label: 'DM Serif Display', script: 'latin', category: 'serif', weights: [400], mood: '优雅展示衬线，美妆、香氛' },
  { family: 'Fraunces', label: 'Fraunces', script: 'latin', category: 'serif', weights: [300, 400, 500, 600, 700, 800, 900], mood: '复古柔和衬线，咖啡、烘焙、手作' },
  { family: 'Cormorant Garamond', label: 'Cormorant Garamond', script: 'latin', category: 'serif', weights: [300, 400, 500, 600, 700], mood: '古典纤细衬线，婚礼、珠宝' },
  { family: 'Pacifico', label: 'Pacifico', script: 'latin', category: 'handwriting', weights: [400], mood: '复古手写体，夏日、冲浪、甜品' },
  { family: 'Space Mono', label: 'Space Mono', script: 'latin', category: 'mono', weights: [400, 700], mood: '等宽科技感，参数、编号、未来感' },
] as const;

export type FontInfo = (typeof FONT_CATALOG)[number];
export type FontFamily = FontInfo['family'];

/** zod enum 要求非空元组：从清单派生，增删字体只改上面一处。 */
export const FONT_FAMILIES = FONT_CATALOG.map((f) => f.family) as [
  FontFamily,
  ...FontFamily[],
];

export const DEFAULT_FONT_FAMILY: FontFamily = 'Noto Sans SC';

export function fontInfo(family: string): FontInfo | undefined {
  return FONT_CATALOG.find((f) => f.family === family);
}

/** 该字体实际有的字重里离 weight 最近的一个（加载与渲染都按它取，避免浏览器伪粗体）。 */
export function nearestFontWeight(family: string, weight: number): number {
  const weights: readonly number[] = fontInfo(family)?.weights ?? [400];
  return weights.reduce((best, w) =>
    Math.abs(w - weight) < Math.abs(best - weight) ? w : best,
  );
}

/**
 * Google Fonts CSS2 地址：一次请求一个族的全部可用字重（中文字体 Google 按 unicode-range 切片，
 * 浏览器只下载用到的字）。后端取 TTF 时用同一地址但换成老 UA，Google 会回 truetype 格式。
 */
export function googleFontCssUrl(family: string): string {
  const weights = fontInfo(family)?.weights ?? [400];
  const name = family.replace(/ /g, '+');
  return `https://fonts.googleapis.com/css2?family=${name}:wght@${weights.join(';')}&display=swap`;
}
