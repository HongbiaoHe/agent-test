/**
 * 预览画面的 WebGL 合成：把当前一段（A）、转场期间叠进来的下一段（B）按转场公式合成到画布上。
 *
 * 公式逐个移植自 ffmpeg 的 vf_xfade.c（导出就用 xfade，且先转成 gbrp 在 RGB 上算），与导出逐像素对应：
 * - 坐标 x / y 为输出像素、左上角为 0；W / H 为输出宽高；进度 P 在转场开始时为 1、结束时为 0；
 * - xfade 的 mix(a, b, m) = a·m + b·(1-m)（不是 GLSL 的 mix），这里叫 xmix；
 * - C 里 int 截断的地方用 floor（值都为正）或显式处理负数；
 * - hblur 的横向均值窗口在 GPU 上逐像素全量累加太慢，改为窗口内均匀取 24 个点近似；dissolve 的伪随机
 *   用同一个 sin 哈希，GPU 的 sin 精度不同，噪点图案不逐点相同（观感一致）。
 * 素材按「等比缩放 + 补黑边」贴进画布（与导出的 scale + pad 一致），转场作用在补好黑边的整帧上。
 * 自定义转场（type = custom）把 video-schema 的表达式翻译成 GLSL，各通道分别求值（PLANE：0 = G、1 = B、2 = R）。
 */
import {
  GLSL_EXPR_HELPERS,
  parseExpr,
  toGlsl,
  type Transition,
  TRANSITION_TYPES,
  type TransitionType,
} from '@agent-test/video-schema';

/** 每种转场：已知 a、b（当前像素的前 / 后一段颜色）、px、x、y、W、H、P，算出 c */
const TRANSITION_GLSL: Record<TransitionType, string> = {
  fade: 'c = xmix(a, b, P);',
  fadeblack:
    'c = xmix(xmix(a, vec3(0.0), sstep(0.8, 1.0, P)), xmix(vec3(0.0), b, sstep(0.2, 1.0, P)), P);',
  fadewhite:
    'c = xmix(xmix(a, vec3(1.0), sstep(0.8, 1.0, P)), xmix(vec3(1.0), b, sstep(0.2, 1.0, P)), P);',
  fadegrays: `
    vec3 g0 = vec3((a.r + a.g + a.b) / 3.0);
    vec3 g1 = vec3((b.r + b.g + b.b) / 3.0);
    c = xmix(xmix(a, g0, sstep(0.8, 1.0, P)), xmix(g1, b, sstep(0.2, 1.0, P)), P);`,
  fadefast: 'vec3 m = pow(vec3(P), 1.0 + log(1.0 + abs(a - b))); c = a * m + b * (1.0 - m);',
  fadeslow: 'vec3 m = pow(vec3(P), 1.0 + log(2.0 - abs(a - b))); c = a * m + b * (1.0 - m);',
  dissolve: 'float s = frand(x, y) * 2.0 + P * 2.0 - 1.5; c = s >= 0.5 ? a : b;',
  distance: 'float d = length(a - b) <= P ? 1.0 : 0.0; c = xmix(xmix(a, b, d), b, P);',
  wipeleft: 'float z = floor(W * P); c = x > z ? b : a;',
  wiperight: 'float z = floor(W * (1.0 - P)); c = x > z ? a : b;',
  wipeup: 'float z = floor(H * P); c = y > z ? b : a;',
  wipedown: 'float z = floor(H * (1.0 - P)); c = y > z ? a : b;',
  wipetl: 'float zw = floor(W * P); float zh = floor(H * P); c = (y <= zh && x <= zw) ? a : b;',
  wipetr: 'float zw = floor(W * (1.0 - P)); float zh = floor(H * P); c = (y <= zh && x > zw) ? a : b;',
  wipebl: 'float zw = floor(W * P); float zh = floor(H * (1.0 - P)); c = (y > zh && x <= zw) ? a : b;',
  wipebr: 'float zh = floor(H * (1.0 - P)); float zw = floor(W * (1.0 - P)); c = (y > zh && x > zw) ? a : b;',
  slideleft: `
    float zx = -floor(P * W) + x; float zz = mod(zx, W);
    c = (zx >= 0.0 && zx < W) ? B(vec2(zz, y)) : A(vec2(zz, y));`,
  slideright: `
    float zx = floor(P * W) + x; float zz = mod(zx, W);
    c = (zx >= 0.0 && zx < W) ? B(vec2(zz, y)) : A(vec2(zz, y));`,
  slideup: `
    float zy = -floor(P * H) + y; float zz = mod(zy, H);
    c = (zy >= 0.0 && zy < H) ? B(vec2(x, zz)) : A(vec2(x, zz));`,
  slidedown: `
    float zy = floor(P * H) + y; float zz = mod(zy, H);
    c = (zy >= 0.0 && zy < H) ? B(vec2(x, zz)) : A(vec2(x, zz));`,
  smoothleft: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + x / W - P * 2.0));',
  smoothright: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + (W - 1.0 - x) / W - P * 2.0));',
  smoothup: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + y / H - P * 2.0));',
  smoothdown: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + (H - 1.0 - y) / H - P * 2.0));',
  diagtl: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + x / W * y / H - P * 2.0));',
  diagtr: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + (W - 1.0 - x) / W * y / H - P * 2.0));',
  diagbl: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + x / W * (H - 1.0 - y) / H - P * 2.0));',
  diagbr: 'c = xmix(b, a, sstep(0.0, 1.0, 1.0 + (W - 1.0 - x) / W * (H - 1.0 - y) / H - P * 2.0));',
  circleopen: `
    vec2 ctr = floor(vec2(W, H) / 2.0);
    float s = length(vec2(x, y) - ctr) / length(ctr) + (P - 0.5) * 3.0;
    c = xmix(a, b, sstep(0.0, 1.0, s));`,
  circleclose: `
    vec2 ctr = floor(vec2(W, H) / 2.0);
    float s = length(vec2(x, y) - ctr) / length(ctr) + (1.0 - P - 0.5) * 3.0;
    c = xmix(b, a, sstep(0.0, 1.0, s));`,
  circlecrop: `
    vec2 ctr = floor(vec2(W, H) / 2.0);
    float z = pow(2.0 * abs(P - 0.5), 3.0) * length(ctr);
    c = z < length(vec2(x, y) - ctr) ? vec3(0.0) : (P < 0.5 ? b : a);`,
  rectcrop: `
    vec2 ctr = floor(vec2(W, H) / 2.0);
    float zh = floor(abs(P - 0.5) * H); float zw = floor(abs(P - 0.5) * W);
    bool inside = abs(x - ctr.x) < zw && abs(y - ctr.y) < zh;
    c = inside ? (P < 0.5 ? b : a) : vec3(0.0);`,
  vertopen: 'float w2 = W / 2.0; c = xmix(b, a, sstep(0.0, 1.0, 2.0 - abs((x - w2) / w2) - P * 2.0));',
  vertclose: 'float w2 = W / 2.0; c = xmix(b, a, sstep(0.0, 1.0, 1.0 + abs((x - w2) / w2) - P * 2.0));',
  horzopen: 'float h2 = H / 2.0; c = xmix(b, a, sstep(0.0, 1.0, 2.0 - abs((y - h2) / h2) - P * 2.0));',
  horzclose: 'float h2 = H / 2.0; c = xmix(b, a, sstep(0.0, 1.0, 1.0 + abs((y - h2) / h2) - P * 2.0));',
  radial: `
    vec2 ctr = floor(vec2(W, H) / 2.0);
    float s = atan(x - ctr.x, y - ctr.y) - (P - 0.5) * (3.14159265358979 * 2.5);
    c = xmix(b, a, sstep(0.0, 1.0, s));`,
  hlslice: `
    float s = sstep(-0.5, 0.0, x / W - P * 1.5);
    c = xmix(b, a, s <= fract(10.0 * x / W) ? 0.0 : 1.0);`,
  hrslice: `
    float xx = (W - 1.0 - x) / W; float s = sstep(-0.5, 0.0, xx - P * 1.5);
    c = xmix(b, a, s <= fract(10.0 * xx) ? 0.0 : 1.0);`,
  vuslice: `
    float s = sstep(-0.5, 0.0, y / H - P * 1.5);
    c = xmix(b, a, s <= fract(10.0 * y / H) ? 0.0 : 1.0);`,
  vdslice: `
    float yy = (H - 1.0 - y) / H; float s = sstep(-0.5, 0.0, yy - P * 1.5);
    c = xmix(b, a, s <= fract(10.0 * yy) ? 0.0 : 1.0);`,
  pixelize: `
    float d = min(P, 1.0 - P); float dist = ceil(d * 50.0) / 50.0;
    float sq = 2.0 * dist * min(W, H) / 20.0;
    vec2 s = dist > 0.0 ? floor(vec2(min((floor(x / sq) + 0.5) * sq, W - 1.0), min((floor(y / sq) + 0.5) * sq, H - 1.0))) : px;
    c = xmix(A(s), B(s), P);`,
  hblur: `
    float prog = P <= 0.5 ? P * 2.0 : (1.0 - P) * 2.0;
    float n = min(floor(1.0 + floor(W / 2.0) * prog), W - x);
    vec3 sa = vec3(0.0); vec3 sb = vec3(0.0);
    for (int i = 0; i < 24; i++) {
      vec2 q = vec2(x + floor((float(i) + 0.5) / 24.0 * n), y);
      sa += A(q); sb += B(q);
    }
    c = xmix(sa / 24.0, sb / 24.0, P);`,
  zoomin: `
    float zf = sstep(0.5, 1.0, P);
    vec2 uv = 0.5 + (vec2(x / W, y / H) - 0.5) * zf;
    c = xmix(A(ceil(uv * (vec2(W, H) - 1.0))), b, sstep(0.0, 0.5, P));`,
  squeezeh: `
    float z = 0.5 + (y / H - 0.5) / P;
    c = (z < 0.0 || z > 1.0) ? b : A(vec2(x, floor(z * (H - 1.0) + 0.5)));`,
  squeezev: `
    float z = 0.5 + (x / W - 0.5) / P;
    c = (z < 0.0 || z > 1.0) ? b : A(vec2(floor(z * (W - 1.0) + 0.5), y));`,
};

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const PRELUDE = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform vec4 uRectA;
uniform vec4 uRectB;
uniform bool uHasB;
uniform vec2 uRes;
uniform float uP;
uniform int uType;
out vec4 outColor;

vec3 fetch(sampler2D t, vec4 rect, vec2 px) {
  vec2 l = ((px + 0.5) / uRes - rect.xy) / rect.zw;
  if (l.x < 0.0 || l.y < 0.0 || l.x > 1.0 || l.y > 1.0) return vec3(0.0);
  return texture(t, l).rgb;
}
vec3 A(vec2 px) { return fetch(uA, uRectA, px); }
vec3 B(vec2 px) { return fetch(uB, uRectB, px); }
vec3 xmix(vec3 a, vec3 b, float m) { return a * m + b * (1.0 - m); }
float sstep(float e0, float e1, float v) { float t = clamp((v - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float frand(float x, float y) { float r = sin(x * 12.9898 + y * 78.233) * 43758.545; return r - floor(r); }
`;

const MAIN_HEAD = `
void main() {
  float W = uRes.x; float H = uRes.y;
  float x = floor(gl_FragCoord.x); float y = H - 1.0 - floor(gl_FragCoord.y);
  vec2 px = vec2(x, y);
  float P = uP;
  vec3 a = A(px);
  if (!uHasB) { outColor = vec4(a, 1.0); return; }
  vec3 b = B(px);
  vec3 c = a;
`;

/** 内置转场的着色器：按 uType（TRANSITION_TYPES 的下标）分支 */
export function builtinFragmentShader(): string {
  const branches = TRANSITION_TYPES.map((t, i) => `  ${i === 0 ? 'if' : 'else if'} (uType == ${i}) { ${TRANSITION_GLSL[t]} }`).join('\n');
  return `${PRELUDE}${MAIN_HEAD}${branches}\n  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);\n}`;
}

/** 自定义转场的着色器：表达式按通道各求一次，A / B 换算成 0～255（同 8 位的 xfade） */
export function customFragmentShader(expr: string): string {
  const body = toGlsl(parseExpr(expr));
  return `${PRELUDE}${GLSL_EXPR_HELPERS}
float customExpr(float X, float Y, float W, float H, float A, float B, float P, float PLANE) { return ${body}; }
${MAIN_HEAD}
  vec3 a8 = floor(a * 255.0 + 0.5); vec3 b8 = floor(b * 255.0 + 0.5);
  c = vec3(
    customExpr(x, y, W, H, a8.r, b8.r, P, 2.0),
    customExpr(x, y, W, H, a8.g, b8.g, P, 0.0),
    customExpr(x, y, W, H, a8.b, b8.b, P, 1.0)
  ) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
}

export type FrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

function sourceSize(src: FrameSource): { width: number; height: number } | null {
  if (src instanceof HTMLVideoElement) {
    return src.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && src.videoWidth > 0
      ? { width: src.videoWidth, height: src.videoHeight }
      : null;
  }
  if (src instanceof HTMLImageElement) {
    return src.complete && src.naturalWidth > 0 ? { width: src.naturalWidth, height: src.naturalHeight } : null;
  }
  return src.width > 0 ? { width: src.width, height: src.height } : null;
}

/** 等比缩放后在画布里的位置（左上为原点、0～1）：同导出的 scale=decrease + pad 居中 */
export function fitRect(src: { width: number; height: number }, out: { width: number; height: number }): [number, number, number, number] {
  const scale = Math.min(out.width / src.width, out.height / src.height);
  const w = (src.width * scale) / out.width;
  const h = (src.height * scale) / out.height;
  return [(1 - w) / 2, (1 - h) / 2, w, h];
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<'uA' | 'uB' | 'uRectA' | 'uRectB' | 'uHasB' | 'uRes' | 'uP' | 'uType', WebGLUniformLocation | null>;
}

export interface CompositeFrame {
  a: FrameSource | null;
  b: FrameSource | null;
  /** 转场（b 不为空时用） */
  transition: Transition | null;
  /** 进度：1 → 0（同 xfade） */
  progress: number;
}

export class TransitionCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly builtin: Program;
  private readonly custom = new Map<string, Program | null>();
  private readonly textures: [WebGLTexture, WebGLTexture];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.builtin = this.compile(builtinFragmentShader());
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.textures = [this.newTexture(), this.newTexture()];
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  }

  private compile(fragment: string): Program {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error('createShader failed');
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'shader link failed');
    const u = (name: string) => gl.getUniformLocation(program, name);
    return {
      program,
      uniforms: { uA: u('uA'), uB: u('uB'), uRectA: u('uRectA'), uRectB: u('uRectB'), uHasB: u('uHasB'), uRes: u('uRes'), uP: u('uP'), uType: u('uType') },
    };
  }

  /** 自定义表达式的程序（按表达式缓存）；翻译 / 编译失败返回 null，退回淡化 */
  private customProgram(expr: string): Program | null {
    if (!this.custom.has(expr)) {
      try {
        this.custom.set(expr, this.compile(customFragmentShader(expr)));
      } catch {
        this.custom.set(expr, null);
      }
    }
    return this.custom.get(expr) ?? null;
  }

  /** 上传一帧到纹理；素材还没有画面时返回 null */
  private upload(unit: 0 | 1, src: FrameSource | null): [number, number, number, number] | null {
    if (!src) return null;
    const size = sourceSize(src);
    if (!size) return null;
    const gl = this.gl;
    gl.activeTexture(unit === 0 ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    return fitRect(size, { width: this.canvas.width, height: this.canvas.height });
  }

  draw(frame: CompositeFrame): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const rectA = this.upload(0, frame.a);
    const rectB = frame.b ? this.upload(1, frame.b) : null;
    if (!rectA && !rectB) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const t = frame.transition;
    const custom = rectA && rectB && t?.type === 'custom' && t.expr ? this.customProgram(t.expr) : null;
    const p = custom ?? this.builtin;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uA, 0);
    gl.uniform1i(p.uniforms.uB, 1);
    // 只有一边有画面（另一边还在载入）：直接画有的那边
    const onlyB = !rectA && rectB;
    gl.uniform4fv(p.uniforms.uRectA, onlyB ? rectB : (rectA ?? [0, 0, 1, 1]));
    gl.uniform4fv(p.uniforms.uRectB, rectB ?? [0, 0, 1, 1]);
    if (onlyB) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    }
    gl.uniform1i(p.uniforms.uHasB, rectA && rectB ? 1 : 0);
    gl.uniform2f(p.uniforms.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(p.uniforms.uP, frame.progress);
    const type = t && t.type !== 'custom' ? TRANSITION_TYPES.indexOf(t.type) : 0;
    gl.uniform1i(p.uniforms.uType, type);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (onlyB) {
      // 还原纹理单元 0 的绑定，下一帧 upload 照常
      gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    }
  }
}
