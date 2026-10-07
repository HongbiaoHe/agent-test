// 用法：node analyze.mjs → 核对旁白落点、配乐让位、三记重击对拍、片名前的静默、峰值（读 stems/）
import { readFileSync } from "node:fs";
const SR = 48000;
const read = (p) => { const b = readFileSync(p); const d = b.indexOf("data") + 8; const n = (b.length - d) / 2; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = b.readInt16LE(d + i * 2) / 32768; return a; };
const rms = (a, t0, t1) => { let s = 0, n = 0; for (let i = Math.max(0, Math.floor(t0 * SR)); i < Math.floor(t1 * SR); i++) { s += a[i] * a[i]; n++; } return +(10 * Math.log10(s / n + 1e-12)).toFixed(1); };
const plan = JSON.parse(readFileSync("plan.json", "utf8"));
const dur = JSON.parse(readFileSync("vo/durations.json", "utf8"));
const nar = read("stems/nar.wav"), mus = read("stems/music.wav"), sfx = read("stems/sfx.wav"), fin = read("stems/final.wav");
console.log("== 旁白落点（旁白轨首次 >-45dB） ==");
plan.narration.forEach((l, k) => {
  const prevEnd = k ? plan.narration[k - 1].at + dur[plan.narration[k - 1].id] : 0;
  let on = -1;
  for (let t = Math.max(l.at - 0.3, prevEnd + 0.1); t < l.at + 0.5 && on < 0; t += 0.01) if (rms(nar, t, t + 0.02) > -45) on = t;
  const next = k < plan.narration.length - 1 ? plan.narration[k + 1].at : plan.duration;
  console.log(l.id, `起 ${on.toFixed(2)}（设 ${l.at}）止 ${(on + dur[l.id]).toFixed(2)}（下一句 ${next}）`, Math.abs(on - l.at) < 0.05 && on + dur[l.id] < next ? "ok" : "CHECK");
});
console.log("== 配乐让位：说话时 vs 同段落里不说话时（dB） ==");
for (const [a, b, c, d] of [[19.6, 20.8, 24.0, 26.2], [35.9, 40.0, 40.4, 41.7], [44.8, 47.8, 51.5, 51.6]]) console.log(`说话 ${a}-${b}: ${rms(mus, a, b)}  不说话 ${c}-${d}: ${rms(mus, c, d)}`);
console.log("== 重击对拍（音效轨 cue 前后 50ms 能量） ==");
for (const c of plan.cues.filter((c) => c.kind === "boom")) console.log(`boom ${c.t}s: 前 ${rms(sfx, c.t - 0.05, c.t)} → 后 ${rms(sfx, c.t, c.t + 0.05)} dB`);
console.log("== 片名前的静默 ==", `成片 ${plan.sections.silence + 0.1}-${plan.sections.boom - 0.05}s: ${rms(fin, plan.sections.silence + 0.1, plan.sections.boom - 0.05)} dB`, `| 片名后 1s: ${rms(fin, plan.sections.boom, plan.sections.boom + 1)} dB`);
let peak = 0; for (const v of fin) peak = Math.max(peak, Math.abs(v)); console.log("成片采样峰值", peak.toFixed(3));
