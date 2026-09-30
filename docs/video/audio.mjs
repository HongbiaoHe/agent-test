// 用法：node audio.mjs plan.json   → 写出 music.wav（配乐）与 sfx.wav（像素点亮等音效）
// plan.json 由 render.mjs cues 从画面导出：总时长、音效时间点、各声部进场时间（都是真实时间）
// 纯数学合成，不依赖任何音色库：正弦 / 泛音 / 白噪声 + 包络 + 一阶滤波。
import { readFileSync, writeFileSync } from "node:fs";

const plan = JSON.parse(readFileSync(process.argv[2] ?? "plan.json", "utf8"));
const SR = 48000;
const DUR = plan.duration;
const SEC = plan.sections;
const N = SR * DUR;
const TAU = Math.PI * 2;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (p) => { p = clamp(p); return p * p * (3 - 2 * p); };

// 可复现的噪声（每次渲染一致）
let seed = 1234567;
const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };

function stereo() { return [new Float32Array(N), new Float32Array(N)]; }
/** 把一段 fn(dt) 生成的单声道音放到 start 处，pan ∈ [-1, 1] */
function place(buf, start, dur, gain, pan, fn) {
  const s0 = Math.max(0, Math.round(start * SR)), s1 = Math.min(N, Math.round((start + dur) * SR));
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let s = s0; s < s1; s++) {
    const v = fn((s - s0) / SR);
    buf[0][s] += v * gl;
    buf[1][s] += v * gr;
  }
}

// ================= 配乐 =================
// 96 BPM，一拍 0.625s，两小节（5s）换一个和弦——正好对齐画面每段的起点
const BEAT = 0.625;
const CHORDS = [
  { tones: [53, 57, 60, 64], root: 41 }, // Fmaj7
  { tones: [57, 60, 64, 67], root: 45 }, // Am7
  { tones: [50, 53, 57, 60], root: 38 }, // Dm7
  { tones: [46, 50, 53, 57], root: 46 - 12 }, // Bbmaj7
];
const OUTRO = { tones: [53, 57, 60, 64, 67], root: 41 }; // Fmaj9，片尾停在这里
// 片尾和弦落在片尾段之前最近的一个 5s 格上；各声部进场时间吸附到拍子上，律动才不会错拍
const OUTRO_AT = Math.floor(SEC.outro / 5) * 5;
const snap = (x) => Math.round(x / BEAT) * BEAT;
const chordAt = (t) => (t >= OUTRO_AT ? OUTRO : CHORDS[Math.floor(t / 5) % 4]);

const music = stereo();

// 铺底 pad：每 5s 一个和弦，前后交叠淡入淡出；左右声道微失谐出宽度
const SEGS = Math.ceil(DUR / 5);
for (let j = 0; j < SEGS; j++) {
  const last = j === SEGS - 1;
  const ch = j * 5 >= OUTRO_AT ? OUTRO : CHORDS[j % 4];
  const start = j * 5 - 0.8, end = last ? DUR : j * 5 + 5 + 1.4;
  ch.tones.forEach((m, k) => {
    const f = midi(m);
    for (const [pan, det] of [[-0.6, 0.997], [0.6, 1.003]]) {
      place(music, start, end - start, 0.05, pan, (dt) => {
        const t = start + dt;
        const env = smooth((t - start) / 1.4) * (1 - smooth((t - (end - 1.6)) / 1.6));
        const lfo = 0.85 + 0.15 * Math.sin(TAU * (0.11 + k * 0.03) * t + k);
        const x = f * det * dt;
        return env * lfo * (Math.sin(TAU * x) + 0.28 * Math.sin(TAU * 2 * x) + 0.08 * Math.sin(TAU * 3 * x));
      });
    }
  });
}

// 低音：胶片带开始后，每两拍一个根音
for (let t = snap(SEC.bass); t < SEC.outro - 1; t += BEAT * 2) {
  const f = midi(chordAt(t).root);
  place(music, t, 1.3, 0.2, 0, (dt) => Math.min(1, dt / 0.01) * Math.exp(-dt / 0.7) * (Math.sin(TAU * f * dt) + 0.2 * Math.sin(TAU * 2 * f * dt)));
}
place(music, SEC.outro - 1, DUR - SEC.outro + 1, 0.2, 0, (dt) => { const f = midi(41); return smooth(dt / 0.05) * (1 - smooth((dt - 3.5) / 2.5)) * Math.sin(TAU * f * dt); });

// 琶音：八分音符在和弦音上爬，胶片带起轻声进来，Agent 出场后加一点
const ARP = [0, 2, 1, 3, 2, 1];
let step = 0;
for (let t = snap(SEC.bass); t < SEC.end; t += BEAT / 2, step++) {
  const ch = chordAt(t);
  const f = midi(ch.tones[ARP[step % ARP.length] % ch.tones.length] + 12);
  const g = t < SEC.hats ? 0.045 : 0.065;
  place(music, t, 0.6, g, step % 2 ? 0.35 : -0.35, (dt) =>
    Math.min(1, dt / 0.003) * Math.exp(-dt / 0.17) * (Math.sin(TAU * f * dt) + 0.35 * Math.sin(TAU * 2 * f * dt) + 0.1 * Math.sin(TAU * 3 * f * dt)));
}

// 反拍踩镲：从 Agent 出场开始
for (let t = snap(SEC.hats) + BEAT / 2; t < SEC.end; t += BEAT) {
  let prev = 0;
  place(music, t, 0.08, 0.05, 0.2, (dt) => { const n = noise(); const hp = n - prev; prev = n; return hp * Math.exp(-dt / 0.022); });
}
// 轻底鼓：画板场景（Agent 开工）才进来，只打 1、3 拍，保持克制
for (let t = snap(SEC.kick); t < SEC.end; t += BEAT * 2) {
  place(music, t, 0.45, 0.4, 0, (dt) => Math.exp(-dt / 0.28) * Math.sin(TAU * (45 * dt + 80 * 0.04 * (1 - Math.exp(-dt / 0.04)))));
}

// pad 过一道一阶低通去掉毛刺
for (const ch of music) {
  let y = 0;
  const a = 1 - Math.exp((-TAU * 2600) / SR);
  for (let s = 0; s < N; s++) { y += a * (ch[s] - y); ch[s] = y; }
}
// 整体淡入淡出
for (let s = 0; s < N; s++) {
  const t = s / SR;
  const g = smooth(t / 2.5) * (1 - smooth((t - (DUR - 1.8)) / 1.8));
  music[0][s] *= g;
  music[1][s] *= g;
}

// ================= 音效 =================
// 像素点亮：F 大调五声音阶上的九个音，九格各一个——一格格亮起来就是一小段旋律
const PIXEL_SCALE = [77, 79, 81, 84, 86, 89, 91, 93, 96];
const sfx = stereo();

function whoosh(t, dur, gain, up = true) {
  let y = 0;
  place(sfx, t, dur, gain, 0, (dt) => {
    const p = dt / dur;
    const fc = up ? 300 + 3200 * p * p : 3500 - 3200 * p;
    y += (1 - Math.exp((-TAU * fc) / SR)) * (noise() - y);
    return y * Math.sin(Math.PI * p);
  });
}
function chime(t, notes, gain) {
  notes.forEach((m, k) => {
    const f = midi(m);
    place(sfx, t + k * 0.06, 1.6, gain, k % 2 ? 0.3 : -0.3, (dt) =>
      Math.min(1, dt / 0.004) * Math.exp(-dt / 0.7) * (Math.sin(TAU * f * dt) + 0.3 * Math.sin(TAU * 2.01 * f * dt)));
  });
}

for (const { t, kind, i, gain } of plan.cues) {
  switch (kind) {
    case "pixel-first": {
      // 第一格：音高 + 一点低频落地感 + 一缕高频余光
      const f = midi(72);
      place(sfx, t, 1.2, 0.3 * gain, 0, (dt) =>
        Math.min(1, dt / 0.002) * (Math.exp(-dt / 0.09) * (Math.sin(TAU * f * dt) + 0.2 * Math.sin(TAU * 3 * f * dt))
          + 0.9 * Math.exp(-dt / 0.1) * Math.sin(TAU * 90 * dt)
          + 0.12 * Math.exp(-dt / 0.5) * Math.sin(TAU * 1760 * dt)));
      break;
    }
    case "pixel": {
      const idx = Math.floor(i) % PIXEL_SCALE.length;
      const f = midi(PIXEL_SCALE[idx]);
      place(sfx, t, 0.3, 0.2 * gain, (idx - 4) / 5, (dt) => {
        const ff = f * (1 + 0.03 * Math.exp(-dt / 0.01));
        return Math.min(1, dt / 0.0015) * Math.exp(-dt / 0.055) * (Math.sin(TAU * ff * dt) + 0.18 * Math.sin(TAU * 3 * ff * dt) + 0.07 * Math.sin(TAU * 5 * ff * dt));
      });
      break;
    }
    case "tick":
      place(sfx, t, 0.05, 0.14 * gain, 0.2, (dt) => Math.exp(-dt / 0.008) * Math.sin(TAU * 1900 * dt));
      break;
    case "click":
      place(sfx, t, 0.06, 0.28 * gain, 0, (dt) => Math.exp(-dt / 0.003) * noise() * 0.8 + Math.exp(-dt / 0.012) * Math.sin(TAU * 2400 * dt) * 0.35);
      break;
    case "key": {
      let prev = 0;
      place(sfx, t, 0.03, 0.09 * gain, 0.4, (dt) => { const n = noise(); const hp = n - prev; prev = n; return hp * Math.exp(-dt / 0.004); });
      break;
    }
    case "pop":
      place(sfx, t, 0.3, 0.28 * gain, 0.1, (dt) => Math.min(1, dt / 0.002) * Math.exp(-dt / 0.08) * Math.sin(TAU * (260 * dt + 260 * (dt - 0.03 * (1 - Math.exp(-dt / 0.03))))));
      break;
    case "whoosh": whoosh(t - 0.05, 0.6, 0.16 * gain); break;
    case "swish": whoosh(t, 0.55, 0.08 * gain); break;
    case "chime": chime(t, [77, 81, 84], 0.085 * gain); break;
    case "state": {
      // 四档各一个双音，音程一样、高度不同：同一张脸，换了表情
      const pairs = [[81, 88], [84, 91], [79, 86], [77, 84]];
      chime(t, pairs[i], 0.08 * gain);
      break;
    }
    case "reveal": {
      // 能力徽章出场：一口上扬的气 + 一串自下而上的像素音（这一格格亮起来的，正是它能生成的东西）
      whoosh(t - 0.35, 0.7, 0.1 * gain);
      const run = i === 0 ? [77, 81, 84, 89] : [79, 84, 88, 91];
      run.forEach((m, k) => {
        const f = midi(m);
        place(sfx, t + k * 0.07, 1.4, 0.075 * gain, (k - 1.5) / 3, (dt) =>
          Math.min(1, dt / 0.003) * Math.exp(-dt / 0.45) * (Math.sin(TAU * f * dt) + 0.25 * Math.sin(TAU * 2.01 * f * dt) + 0.08 * Math.sin(TAU * 3 * f * dt)));
      });
      break;
    }
    case "swell": {
      // 片尾的一口「吸气」：噪声与和弦一起涨上来再落下
      whoosh(t - 0.6, 1.4, 0.1 * gain);
      chime(t + 0.3, [65, 72, 77, 81], 0.06 * gain);
      break;
    }
  }
}

// ================= 写 WAV（16-bit PCM 立体声） =================
function writeWav(path, [l, r], peak) {
  let max = 0;
  for (let s = 0; s < N; s++) max = Math.max(max, Math.abs(l[s]), Math.abs(r[s]));
  const k = max > 0 ? peak / max : 1;
  const buf = Buffer.alloc(44 + N * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
  for (let s = 0; s < N; s++) {
    buf.writeInt16LE(Math.round(clamp(l[s] * k, -1, 1) * 32767), 44 + s * 4);
    buf.writeInt16LE(Math.round(clamp(r[s] * k, -1, 1) * 32767), 46 + s * 4);
  }
  writeFileSync(path, buf);
  console.log(`${path}: peak ${max.toFixed(3)} → ${peak}`);
}
writeWav("music.wav", music, 0.5);
writeWav("sfx.wav", sfx, 0.7);
