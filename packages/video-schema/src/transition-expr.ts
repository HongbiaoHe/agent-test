/**
 * 自定义转场表达式：ffmpeg xfade `transition=custom:expr=...` 的表达式语言（libavutil/eval）的一个安全子集。
 * 同一条表达式：导出时原样交给 ffmpeg；预览时用 toGlsl 翻译成 WebGL 着色器——两边逐像素算同一个公式。
 *
 * 语义（同 xfade）：对每个像素的每个颜色通道求值一次，结果就是输出值（0～255）。
 * 变量：X / Y（像素坐标，左上角为 0）、W / H（画面宽高）、A / B（前一段 / 后一段该像素该通道的值，0～255）、
 *       P（进度：转场开始时为 1，结束时为 0）、PLANE（通道：0 = G、1 = B、2 = R，导出在 gbrp 上做）；
 * 常量：PI、E、PHI；运算：+ - * / ^（乘方，左结合）与括号；
 * 函数：sin cos tan asin acos atan atan2 exp log sqrt abs floor ceil trunc round
 *       min max pow hypot mod clip between gt gte lt lte eq not if ifnot。
 * 不支持 st / ld / random 和 `;` 串联（预览没法逐像素保存状态）。
 */

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: ExprVar }
  | { kind: 'neg'; arg: ExprNode }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: ExprNode; right: ExprNode }
  | { kind: 'call'; fn: ExprFn; args: ExprNode[] };

export const EXPR_VARS = ['X', 'Y', 'W', 'H', 'A', 'B', 'P', 'PLANE'] as const;
export type ExprVar = (typeof EXPR_VARS)[number];

const CONSTANTS: Record<string, number> = { PI: Math.PI, E: Math.E, PHI: (1 + Math.sqrt(5)) / 2 };

/** 函数名 → 允许的参数个数 */
const FUNCTIONS = {
  sin: [1],
  cos: [1],
  tan: [1],
  asin: [1],
  acos: [1],
  atan: [1],
  atan2: [2],
  exp: [1],
  log: [1],
  sqrt: [1],
  abs: [1],
  floor: [1],
  ceil: [1],
  trunc: [1],
  round: [1],
  min: [2],
  max: [2],
  pow: [2],
  hypot: [2],
  mod: [2],
  clip: [3],
  between: [3],
  gt: [2],
  gte: [2],
  lt: [2],
  lte: [2],
  eq: [2],
  not: [1],
  if: [2, 3],
  ifnot: [2, 3],
} as const satisfies Record<string, readonly number[]>;
export type ExprFn = keyof typeof FUNCTIONS;

const isFn = (name: string): name is ExprFn => Object.hasOwn(FUNCTIONS, name);
const isVar = (name: string): name is ExprVar => EXPR_VARS.some((v) => v === name);

export const MAX_EXPR_LENGTH = 2000;
const MAX_DEPTH = 64;

export class ExprError extends Error {}

/** 解析表达式；语法不对 / 用了不支持的变量或函数时抛 ExprError（message 是中文，直接给 agent 看） */
export function parseExpr(src: string): ExprNode {
  if (src.length > MAX_EXPR_LENGTH) throw new ExprError(`表达式太长（最多 ${MAX_EXPR_LENGTH} 个字符）`);
  let i = 0;
  let depth = 0;
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = () => {
    skip();
    return src[i] ?? '';
  };
  const expect = (ch: string) => {
    if (peek() !== ch) throw new ExprError(`第 ${i + 1} 个字符处应为「${ch}」`);
    i++;
  };

  // subexpr := term (('+' | '-') term)*
  const subexpr = (): ExprNode => {
    if (++depth > MAX_DEPTH) throw new ExprError('表达式嵌套太深');
    let left = term();
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      i++;
      left = { kind: 'bin', op: c, left, right: term() };
    }
    depth--;
    return left;
  };
  // term := factor (('*' | '/') factor)*
  const term = (): ExprNode => {
    let left = factor();
    for (let c = peek(); c === '*' || c === '/'; c = peek()) {
      i++;
      left = { kind: 'bin', op: c, left, right: factor() };
    }
    return left;
  };
  // factor := [sign] primary ('^' [sign] primary)*；符号作用在整个乘方链上（同 libavutil：-2^2 = -4）
  const signed = (): { neg: boolean; node: ExprNode } => {
    let neg = false;
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      i++;
      if (c === '-') neg = !neg;
    }
    return { neg, node: primary() };
  };
  const factor = (): ExprNode => {
    const first = signed();
    let node = first.node;
    while (peek() === '^') {
      i++;
      const r = signed();
      node = { kind: 'bin', op: '^', left: node, right: r.neg ? { kind: 'neg', arg: r.node } : r.node };
    }
    return first.neg ? { kind: 'neg', arg: node } : node;
  };
  const primary = (): ExprNode => {
    const c = peek();
    if (c === '(') {
      i++;
      const node = subexpr();
      expect(')');
      return node;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return { kind: 'num', value: Number(num[0]) };
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!id) throw new ExprError(c ? `第 ${i + 1} 个字符「${c}」无法识别` : '表达式不完整');
    const name = id[0];
    i += name.length;
    if (peek() === '(') {
      if (!isFn(name)) throw new ExprError(`不支持的函数：${name}`);
      i++;
      const args: ExprNode[] = [];
      if (peek() !== ')') {
        args.push(subexpr());
        while (peek() === ',') {
          i++;
          args.push(subexpr());
        }
      }
      expect(')');
      const arity: readonly number[] = FUNCTIONS[name];
      if (!arity.includes(args.length)) throw new ExprError(`${name} 需要 ${arity.join(' 或 ')} 个参数，给了 ${args.length} 个`);
      return { kind: 'call', fn: name, args };
    }
    if (isVar(name)) return { kind: 'var', name };
    const k = CONSTANTS[name];
    if (k !== undefined) return { kind: 'num', value: k };
    throw new ExprError(`不认识的变量：${name}（可用 ${EXPR_VARS.join(' ')} 与常量 PI E PHI）`);
  };

  const node = subexpr();
  if (peek() !== '') throw new ExprError(`第 ${i + 1} 个字符「${src[i]}」多余${src[i] === ';' ? '（不支持用 ; 串联）' : ''}`);
  return node;
}

/** 校验：合法返回 null，否则返回中文错误 */
export function validateExpr(src: string): string | null {
  try {
    parseExpr(src);
    return null;
  } catch (e) {
    return e instanceof ExprError ? e.message : String(e);
  }
}

export type ExprEnv = Record<ExprVar, number>;

const bool = (b: boolean) => (b ? 1 : 0);
/** C 的 round：.5 远离 0 */
const cRound = (x: number) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5);

/** 在 JS 里求值（单测与缩略图用；语义同 libavutil） */
export function evalExpr(node: ExprNode, env: ExprEnv): number {
  const ev = (n: ExprNode): number => evalExpr(n, env);
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var':
      return env[node.name];
    case 'neg':
      return -ev(node.arg);
    case 'bin': {
      const a = ev(node.left);
      const b = ev(node.right);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return a ** b;
      }
      break;
    }
    case 'call': {
      const v = node.args.map(ev);
      const [a = 0, b = 0, c = 0] = v;
      switch (node.fn) {
        case 'sin':
          return Math.sin(a);
        case 'cos':
          return Math.cos(a);
        case 'tan':
          return Math.tan(a);
        case 'asin':
          return Math.asin(a);
        case 'acos':
          return Math.acos(a);
        case 'atan':
          return Math.atan(a);
        case 'atan2':
          return Math.atan2(a, b);
        case 'exp':
          return Math.exp(a);
        case 'log':
          return Math.log(a);
        case 'sqrt':
          return Math.sqrt(a);
        case 'abs':
          return Math.abs(a);
        case 'floor':
          return Math.floor(a);
        case 'ceil':
          return Math.ceil(a);
        case 'trunc':
          return Math.trunc(a);
        case 'round':
          return cRound(a);
        case 'min':
          return Math.min(a, b);
        case 'max':
          return Math.max(a, b);
        case 'pow':
          return a ** b;
        case 'hypot':
          return Math.hypot(a, b);
        case 'mod':
          return a - Math.floor(a / b) * b;
        case 'clip':
          return Math.min(Math.max(a, b), c);
        case 'between':
          return bool(a >= b && a <= c);
        case 'gt':
          return bool(a > b);
        case 'gte':
          return bool(a >= b);
        case 'lt':
          return bool(a < b);
        case 'lte':
          return bool(a <= b);
        case 'eq':
          return bool(a === b);
        case 'not':
          return bool(a === 0);
        case 'if':
          return a !== 0 ? b : v.length > 2 ? c : 0;
        case 'ifnot':
          return a === 0 ? b : v.length > 2 ? c : 0;
      }
    }
  }
  return Number.NaN;
}

const glNum = (n: number) => {
  if (!Number.isFinite(n)) return n > 0 ? '1e30' : n < 0 ? '-1e30' : '0.0';
  const s = String(n);
  return /[.eE]/.test(s) ? (s.startsWith('.') ? `0${s}` : s) : `${s}.0`;
};

/**
 * 翻译成 GLSL 表达式（float）。变量直接用同名 float（着色器里由 customExpr 的参数提供），
 * 用到的辅助函数（x_pow / x_round / x_hypot）在 GLSL_EXPR_HELPERS 里。
 */
export function toGlsl(node: ExprNode): string {
  const g = toGlsl;
  switch (node.kind) {
    case 'num':
      return glNum(node.value);
    case 'var':
      return node.name;
    case 'neg':
      return `(-${g(node.arg)})`;
    case 'bin':
      return node.op === '^' ? `x_pow(${g(node.left)}, ${g(node.right)})` : `(${g(node.left)} ${node.op} ${g(node.right)})`;
    case 'call': {
      const a = node.args.map(g);
      const cmp = (op: string) => `((${a[0]}) ${op} (${a[1]}) ? 1.0 : 0.0)`;
      switch (node.fn) {
        case 'sin':
        case 'cos':
        case 'tan':
        case 'asin':
        case 'acos':
        case 'atan':
        case 'exp':
        case 'log':
        case 'sqrt':
        case 'abs':
        case 'floor':
        case 'ceil':
        case 'trunc':
        case 'min':
        case 'max':
          return `${node.fn}(${a.join(', ')})`;
        case 'atan2':
          return `atan(${a[0]}, ${a[1]})`;
        case 'round':
          return `x_round(${a[0]})`;
        case 'pow':
          return `x_pow(${a[0]}, ${a[1]})`;
        case 'hypot':
          return `x_hypot(${a[0]}, ${a[1]})`;
        case 'mod':
          return `x_mod(${a[0]}, ${a[1]})`;
        case 'clip':
          return `clamp(${a[0]}, ${a[1]}, ${a[2]})`;
        case 'between':
          return `((${a[0]}) >= (${a[1]}) && (${a[0]}) <= (${a[2]}) ? 1.0 : 0.0)`;
        case 'gt':
          return cmp('>');
        case 'gte':
          return cmp('>=');
        case 'lt':
          return cmp('<');
        case 'lte':
          return cmp('<=');
        case 'eq':
          return cmp('==');
        case 'not':
          return `((${a[0]}) == 0.0 ? 1.0 : 0.0)`;
        case 'if':
          return `((${a[0]}) != 0.0 ? (${a[1]}) : (${a[2] ?? '0.0'}))`;
        case 'ifnot':
          return `((${a[0]}) == 0.0 ? (${a[1]}) : (${a[2] ?? '0.0'}))`;
      }
    }
  }
  return '0.0';
}

/** toGlsl 用到的辅助函数：负底数的整数次幂、C 的 round、mod 与 hypot（GLSL 自带的语义不同或没有） */
export const GLSL_EXPR_HELPERS = `
float x_pow(float a, float b) {
  if (a >= 0.0) return pow(a, b);
  if (b != floor(b)) return 0.0 / 0.0;
  float r = pow(-a, b);
  return mod(b, 2.0) == 0.0 ? r : -r;
}
float x_round(float a) { return sign(a) * floor(abs(a) + 0.5); }
float x_mod(float a, float b) { return a - floor(a / b) * b; }
float x_hypot(float a, float b) { return sqrt(a * a + b * b); }
`;
