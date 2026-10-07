// 用法：node audio.mjs plan.json → music.wav（配乐）+ sfx.wav（音效）
// 纯数学合成：polyBLEP 锯齿波 / 正弦 / 白噪声 + 包络 + 状态变量滤波（SVF）。所有时间点来自 plan.json（画面导出）。
import { readFileSync, writeFileSync } from "node:fs";

const plan = JSON.parse(readFileSync(process.argv[2] ?? "plan.json", "utf8"));
const SEC = plan.sections;
const SR = 48000, DUR = plan.duration, N = Math.ceil(SR * DUR), TAU = Math.PI * 2;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (p) => { p = clamp(p); return p * p * (3 - 2 * p); };
const seg = (t, a, b) => clamp((t - a) / (b - a));
let seed = 99;
const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
const stereo = () => [new Float32Array(N), new Float32Array(N)];

function place(buf, start, dur, gain, pan, fn) {
  const s0 = Math.max(0, Math.round(start * SR)), s1 = Math.min(N, Math.round((start + dur) * SR));
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let s = s0; s < s1; s++) { const v = fn((s - s0) / SR, s / SR); buf[0][s] += v * gl; buf[1][s] += v * gr; }
}
/** 带限锯齿波（polyBLEP），返回一个按调用推进的振荡器 */
function saw(freq) {
  let ph = (noise() + 1) / 2; // 初相用可复现的噪声，每次渲染结果一致
  return (f = freq) => {
    const dt = f / SR;
    ph += dt; if (ph >= 1) ph -= 1;
    let v = 2 * ph - 1;
    if (ph < dt) { const x = ph / dt; v -= x + x - x * x - 1; } else if (ph > 1 - dt) { const x = (ph - 1) / dt; v -= x * x + x + x + 1; }
    return v;
  };
}
/**
 * 状态变量低通（Chamberlin）；fc 可逐样本变化，q 是阻尼（越大越不共振）。
 * 这种结构只在 f² + 2qf < 4 时稳定——阻尼大、截止高时会发散成 Infinity，所以按 q 把 f 限在稳定区内（留一成余量）。
 */
function svf(q = 0.7) {
  let low = 0, band = 0;
  const fMax = -q + Math.sqrt(q * q + 3.6);
  return (x, fc) => { const f = Math.min(fMax, 2 * Math.sin((Math.PI * Math.min(fc, SR / 7)) / SR)); low += f * band; const high = x - low - q * band; band += f * high; return low; };
}

// ================= 配乐 =================
// D 小调，120 BPM（一拍 0.5s），每两小节（4s）换和弦：Dm → B♭ → F → C
const BEAT = 0.5;
const CH = [
  { root: 38, tones: [50, 53, 57, 62] }, // Dm
  { root: 34, tones: [46, 50, 53, 58] }, // B♭
  { root: 41, tones: [53, 57, 60, 65] }, // F
  { root: 36, tones: [48, 52, 55, 60] }, // C
];
const chordAt = (t) => CH[Math.floor(t / 4) % 4];
const inGroove = (t) => (t >= SEC.groove && t < SEC.impact - 1.9) || (t >= SEC.impact && t < SEC.grooveEnd);
const music = stereo();

// 1) 低频持续音：D1 + A1，一直压到坍缩结束；开场最响，律动进来后退到底下
place(music, 0, SEC.silence, 1, 0, (dt, t) => {
  const g = smooth(t / 3) * (1 - smooth((t - (SEC.silence - 0.6)) / 0.6)) * (t < SEC.groove ? 0.2 : 0.11);
  const lfo = 0.8 + 0.2 * Math.sin(TAU * 0.13 * t);
  return g * lfo * (Math.sin(TAU * midi(26) * t) + 0.6 * Math.sin(TAU * midi(33) * t) + 0.15 * Math.sin(TAU * midi(38) * t));
});

// 2) 和弦铺底：失谐锯齿 → 低通。截止频率跟着段落开合：拉远时慢慢打开，折叠时收紧，撞击后全开，坍缩时关死
{
  const bus = stereo();
  for (let j = 0; j * 4 < SEC.silence; j++) {
    const start = j * 4, ch = CH[j % 4];
    if (start + 4 < 5.5) continue;
    for (const [k, m] of ch.tones.entries()) for (const [pan, det] of [[-0.7, 0.996], [0.7, 1.004]]) {
      const osc = saw(midi(m) * det);
      place(bus, start - 0.6, 4 + 1.8, 0.035, pan * (k % 2 ? 1 : 0.6), (dt) => osc() * smooth(dt / 1.0) * (1 - smooth((dt - 4.2) / 1.6)));
    }
  }
  const fcAt = (t) => {
    if (t < 6) return 300;
    if (t < SEC.groove) return 300 + 1300 * smooth((t - 6) / 10);
    if (t < SEC.impact - 1.9) return 2200;
    if (t < SEC.impact) return 2200 - 1900 * smooth((t - (SEC.impact - 1.9)) / 1.9);
    if (t < SEC.grooveEnd) return 3200;
    return 3200 - 3100 * smooth((t - SEC.grooveEnd) / (SEC.silence - SEC.grooveEnd));
  };
  const gAt = (t) => smooth((t - 5.5) / 3) * (t < SEC.grooveEnd ? 1 : 1 - smooth((t - SEC.grooveEnd) / (SEC.silence - SEC.grooveEnd)));
  for (let c = 0; c < 2; c++) { const f = svf(0.9); for (let s = 0; s < N; s++) { const t = s / SR; music[c][s] += f(bus[c][s], fcAt(t)) * gAt(t); } }
}

// 3) 低音：律动里每个八分音符打一下根音（锯齿 + 低通，短衰减），是推着画面往前冲的那股劲
for (let t = SEC.groove; t < SEC.grooveEnd; t += BEAT / 2) {
  if (!inGroove(t)) continue;
  const f = midi(chordAt(t).root);
  const osc = saw(f), lp = svf(1.2);
  const acc = Math.round(t / (BEAT / 2)) % 4 === 0 ? 1 : 0.7;
  place(music, t, 0.24, 0.22 * acc, 0, (dt) => lp(osc() + 0.5 * Math.sin(TAU * f * 0.5 * dt), 180 + 900 * Math.exp(-dt / 0.05)) * Math.min(1, dt / 0.004) * Math.exp(-dt / 0.12));
}

// 4) 鼓：隧道里 22s 起四拍底鼓把速度感垫起来；撞击之后加上 2、4 拍的拍手和十六分踩镲
function kick(t, g) { place(music, t, 0.5, g, 0, (dt) => Math.sin(TAU * (48 * dt + 110 * 0.035 * (1 - Math.exp(-dt / 0.035)))) * Math.exp(-dt / 0.22) + 0.3 * noise() * Math.exp(-dt / 0.004)); }
for (let t = 22; t < SEC.grooveEnd; t += BEAT) if (inGroove(t)) kick(t, t < SEC.impact ? 0.45 : 0.55);
for (let t = SEC.impact + BEAT; t < SEC.grooveEnd; t += BEAT * 2) {
  let y = 0;
  place(music, t, 0.3, 0.2, 0.1, (dt) => { y += 0.35 * (noise() - y); return (noise() - y) * Math.exp(-dt / 0.06) + 0.4 * Math.sin(TAU * 190 * dt) * Math.exp(-dt / 0.04); });
}
for (let t = SEC.groove; t < SEC.grooveEnd; t += BEAT / 4) {
  if (!inGroove(t)) continue;
  let prev = 0;
  const off = Math.round(t / (BEAT / 4)) % 2 ? 1 : 0.55;
  place(music, t, 0.05, (t < SEC.impact ? 0.035 : 0.05) * off, 0.3, (dt) => { const n = noise(); const hp = n - prev; prev = n; return hp * Math.exp(-dt / 0.012); });
}

// 5) 片名那一记之后：一个很长的 Dm(add9)，带一层高八度的微光，一直延到黑场
{
  const tones = [38, 45, 50, 53, 57, 64, 69];
  for (const [k, m] of tones.entries()) for (const det of [0.997, 1.003]) {
    const osc = saw(midi(m) * det), lp = svf(0.8);
    const len = DUR - SEC.boom;
    place(music, SEC.boom, len, 0.035, (k % 3) - 1, (dt) => lp(osc(), 400 + 2200 * Math.exp(-dt / 2.2)) * Math.min(1, dt / 0.03) * (1 - smooth((dt - (len - 2.5)) / 2.5)));
    place(music, SEC.boom + 0.3, len - 0.3, 0.012, (k % 2) * 2 - 1, (dt) => Math.sin(TAU * midi(m + 24) * det * dt) * smooth(dt / 1.5) * (0.7 + 0.3 * Math.sin(TAU * 5 * dt)) * (1 - smooth((dt - (len - 3)) / 2.7)));
  }
}
// 开头 0.6s 淡入，结尾 1.2s 淡出
for (let s = 0; s < N; s++) { const t = s / SR; const g = smooth(t / 0.6) * (1 - smooth((t - (DUR - 1.2)) / 1.2)); music[0][s] *= g; music[1][s] *= g; }

// ================= 音效 =================
const sfx = stereo();
const PENTA = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88, 90, 93]; // D 大调五声，往上爬
function whoosh(t, dur, gain, f0 = 300, f1 = 3500, pan = 0) {
  const lp = svf(1.4);
  place(sfx, t, dur, gain, pan, (dt) => { const p = dt / dur; return lp(noise(), f0 + (f1 - f0) * p * p) * Math.sin(Math.PI * p); });
}
function boom(t, g) {
  // 次低频下潜 + 低通噪声的冲击 + 起音的一下「咔」
  place(sfx, t, 3.2, g, 0, (dt) => Math.sin(TAU * (30 * dt + 70 * 0.25 * (1 - Math.exp(-dt / 0.25)))) * Math.exp(-dt / 1.1) * 0.9);
  const lp = svf(0.7);
  place(sfx, t, 2.2, g * 0.9, 0, (dt) => lp(noise(), 120 + 1800 * Math.exp(-dt / 0.08)) * Math.exp(-dt / 0.6));
  place(sfx, t, 0.03, g * 0.5, 0, (dt) => noise() * Math.exp(-dt / 0.004));
}
function riser(t, dur, g) {
  // 噪声的截止频率与一条正弦的音高一起往上推，结尾戛然而止
  const lp = svf(2);
  place(sfx, t, dur, g, 0, (dt) => {
    const p = dt / dur, e = Math.pow(p, 2.2);
    return lp(noise(), 400 + 7000 * e) * e * 0.8 + Math.sin(TAU * (200 * dt + 900 * dur * Math.pow(p, 3) / 3)) * e * 0.25;
  });
}
function suck(t, dur, g) {
  // 反向的吸入：像倒放的镲，越来越响，最后一刻切断
  let y = 0;
  place(sfx, t, dur, g, 0, (dt) => { const p = dt / dur; y += 0.2 * (noise() - y); return ((noise() - y) * 0.7 + y) * Math.pow(p, 3) + Math.sin(TAU * (60 * dt + 200 * dur * p * p / 2)) * Math.pow(p, 2) * 0.3; });
}
function pluck(t, m, g, pan = 0, decay = 0.08) {
  const f = midi(m);
  place(sfx, t, 0.5, g, pan, (dt) => Math.min(1, dt / 0.0015) * Math.exp(-dt / decay) * (Math.sin(TAU * f * dt) + 0.2 * Math.sin(TAU * 3 * f * dt) + 0.06 * Math.sin(TAU * 5 * f * dt)));
}
for (const { t, kind, i, gain } of plan.cues) {
  switch (kind) {
    case "heart":
      place(sfx, t, 0.4, 0.5 * gain, 0, (dt) => Math.sin(TAU * (42 * dt + 30 * 0.03 * (1 - Math.exp(-dt / 0.03)))) * Math.exp(-dt / 0.12));
      break;
    case "riser": riser(t, i / 10, 0.35 * gain); break;
    case "suck": suck(t, i / 10, 0.4 * gain); break;
    case "boom": boom(t, 0.9 * gain); break;
    case "pixel": pluck(t, PENTA[Math.floor(i) % PENTA.length] + 12, 0.16 * gain, ((i % 5) - 2) / 3, 0.07); break;
    case "tick": {
      // 波前每扩一圈：音高随圈数往上爬，越到后面越密越高
      const m = PENTA[Math.min(PENTA.length - 1, Math.floor((i / 121) * PENTA.length))] + 12;
      pluck(t, m, 0.12 * gain, (Math.sin(i) * 0.6), 0.05);
      break;
    }
    case "hit": {
      place(sfx, t, 1.2, 0.45 * gain, 0, (dt) => Math.sin(TAU * (55 * dt + 60 * 0.05 * (1 - Math.exp(-dt / 0.05)))) * Math.exp(-dt / 0.35));
      const ch = [62, 69, 74, 77];
      ch.forEach((m, k) => pluck(t + k * 0.012, m, 0.07 * gain, (k - 1.5) / 2, 0.5));
      whoosh(t - 0.4, 0.45, 0.08 * gain, 500, 5000);
      break;
    }
    case "whoosh": whoosh(t, 1.0, 0.2 * gain, 250, 4000); break;
    case "pass": whoosh(t - 0.12, 0.28, 0.1 * gain, 800, 3500, Math.cos(i * 0.62) * 0.8); break;
    case "whooshBig":
      whoosh(t - 0.3, 0.6, 0.22 * gain, 300, 6000);
      place(sfx, t, 0.4, 0.3 * gain, 0, (dt) => Math.sin(TAU * 70 * dt) * Math.exp(-dt / 0.12));
      break;
    case "braam": {
      // 冲进隧道的那一声：一簇失谐锯齿，低通从闷到亮再慢慢合上
      const tones = [26, 33, 38, 41, 45];
      for (const m of tones) for (const det of [0.994, 1, 1.006]) {
        const osc = saw(midi(m) * det), lp = svf(1.1);
        place(sfx, t, 3.4, 0.07 * gain, (det - 1) * 150, (dt) => lp(osc(), 150 + 2600 * Math.min(1, dt / 0.25) * Math.exp(-dt / 1.1)) * Math.min(1, dt / 0.02) * Math.exp(-dt / 1.4));
      }
      boom(t, 0.5 * gain);
      break;
    }
    case "state": {
      // 四张脸各一记：低频重拍 + 一个不同高度的和弦音
      place(sfx, t, 0.6, 0.45 * gain, 0, (dt) => Math.sin(TAU * (50 * dt + 90 * 0.03 * (1 - Math.exp(-dt / 0.03)))) * Math.exp(-dt / 0.25));
      const tops = [[74, 81], [76, 83], [72, 79], [69, 76]][i];
      tops.forEach((m, k) => pluck(t + k * 0.03, m, 0.08 * gain, k ? 0.4 : -0.4, 0.6));
      break;
    }
    case "key": {
      let prev = 0;
      place(sfx, t, 0.03, 0.08 * gain, 0.3, (dt) => { const n = noise(); const hp = n - prev; prev = n; return hp * Math.exp(-dt / 0.004); });
      break;
    }
    case "pop":
      place(sfx, t, 0.25, 0.22 * gain, 0, (dt) => Math.min(1, dt / 0.002) * Math.exp(-dt / 0.07) * Math.sin(TAU * (240 * dt + 300 * (dt - 0.025 * (1 - Math.exp(-dt / 0.025))))));
      break;
    case "zap": {
      // 连线接通：一道上扫的电流
      place(sfx, t, 0.5, 0.08 * gain, 0.2, (dt) => { const p = dt / 0.5; return Math.sin(TAU * (500 * dt + 2400 * dt * dt)) * Math.sin(Math.PI * p) * (0.7 + 0.3 * noise()); });
      break;
    }
    case "chord": break; // 长和弦在配乐里（music 第 5 段）
  }
}

function writeWav(path, [l, r], peak) {
  let max = 0, bad = 0;
  for (let s = 0; s < N; s++) if (!Number.isFinite(l[s]) || !Number.isFinite(r[s])) bad++;
  if (bad) throw new Error(`${path}: ${bad} 个采样不是有限数（滤波发散？）`);
  for (let s = 0; s < N; s++) max = Math.max(max, Math.abs(l[s]), Math.abs(r[s]));
  const k = max > 0 ? peak / max : 1;
  const buf = Buffer.alloc(44 + N * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
  for (let s = 0; s < N; s++) { buf.writeInt16LE(Math.round(clamp(l[s] * k, -1, 1) * 32767), 44 + s * 4); buf.writeInt16LE(Math.round(clamp(r[s] * k, -1, 1) * 32767), 46 + s * 4); }
  writeFileSync(path, buf);
  console.log(`${path}: peak ${max.toFixed(3)} → ${peak}`);
}
writeWav("music.wav", music, 0.6);
writeWav("sfx.wav", sfx, 0.8);
