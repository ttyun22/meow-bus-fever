/**
 * 事件音效模块（Web Audio 程序化音效，无外部素材、无网络依赖）。
 * ------------------------------------------------------------
 * 主游戏事件音效（SFX）：统一入口 playSound(name)，
 * muted / 未解锁 / 播放异常一律静默跳过，绝不影响游戏逻辑；
 * 同名音效 90ms 内去重，防止连点叠加爆音。
 *
 * 点击音效候选（CLICK_CANDIDATES）：供「音效试听选择器」
 * （sound-lab.html）试听与选择。本轮只提供候选与统一调用接口，
 * 不替换主游戏现有音效；用户确认后再把选定方案接入主游戏。
 *  - previewClick(id)：试听入口，自动停止上一段试听（防叠加）；
 *  - 选择结果通过 setClickChoice / getClickChoice 持久化。
 *
 * 音量：所有声音（含主游戏与试听）统一经 masterGain 输出，
 * setVolume 持久化（localStorage）。
 * AudioContext 懒创建 + 首次用户手势解锁（unlockAudio），
 * 符合浏览器自动播放策略；播放失败一律静默。
 */
const MUTE_KEY = 'bus-sound-muted';
const VOLUME_KEY = 'bus-sound-volume';
const CLICK_CHOICE_KEY = 'bus-click-sound-v1';

let ctx = null;
let ctxFailed = false;
let muted = false;
let volume = 1;
let masterGain = null;
const lastPlay = {};

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
} catch { /* 隐私模式等场景下忽略 */ }

/** 当前环境是否具备 Web Audio 能力（试听页据此给出提示）。 */
export function isAudioSupported() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

function ensureCtx() {
  if (ctx || ctxFailed) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { ctxFailed = true; return null; }
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(ctx.destination);
  } catch {
    ctxFailed = true;
    return null;
  }
  return ctx;
}

/** 首次用户手势时调用：解锁自动播放限制。 */
export function unlockAudio() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {});
  }
}

/* ---------------- 基础发音器 ---------------- */

/** 试听中的振荡器：用于「同一时间只播放一个试听音效」。 */
let previewNodes = [];

function stopPreview() {
  for (const n of previewNodes) {
    try { n.stop(); } catch { /* 已停止 */ }
    try { n.disconnect(); } catch { /* 已断开 */ }
  }
  previewNodes = [];
}

/**
 * 单音。opts.track = true 时登记为试听音（可被 stopPreview 中止）。
 * 包络：gain 指数衰减到接近 0，避免爆音尾。
 */
function tone(freq, dur, opts = {}) {
  const { type = 'sine', gain = 0.1, when = 0, sweepTo = null, sweep2 = null, track = false } = opts;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t0 + (sweep2 ? sweep2.at : dur));
  if (sweep2) osc.frequency.exponentialRampToValueAtTime(sweep2.to, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
  if (track) {
    previewNodes.push(osc, g);
    osc.onended = () => {
      previewNodes = previewNodes.filter((n) => n !== osc && n !== g);
    };
  }
}

/** 柔和打击感的短噪声（木质/气泡质感的「敲击瞬态」）。 */
function noiseKnock(dur, opts = {}) {
  const { gain = 0.06, when = 0, freq = 1200, track = false } = opts;
  const t0 = ctx.currentTime + when;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(masterGain);
  src.start(t0);
  if (track) {
    previewNodes.push(src, g);
    src.onended = () => {
      previewNodes = previewNodes.filter((n) => n !== src && n !== g);
    };
  }
}

/** 音效表：主游戏事件音，全部为轻量合成音，音量克制。
 *  （巴士驶出/发车离场不设音效——移动由动画表达即可。） */
const SFX = {
  click: () => tone(700, 0.06, { type: 'square', gain: 0.045 }),
  board: () => tone(620, 0.09, { gain: 0.1 }),
  illegal: () => {
    tone(180, 0.12, { type: 'sawtooth', gain: 0.09 });
    tone(150, 0.12, { when: 0.1, type: 'sawtooth', gain: 0.07 });
  },
  undo: () => {
    tone(500, 0.07, { gain: 0.08 });
    tone(380, 0.1, { when: 0.07, gain: 0.08 });
  },
  lose: () => {
    [440, 330, 220].forEach((f, i) => tone(f, 0.22, { when: i * 0.16, type: 'triangle', gain: 0.1 }));
  },
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { when: i * 0.12, type: 'triangle', gain: 0.1 }));
  },
};

/**
 * 播放主游戏事件音效。任何失败（未解锁/被静音/上下文不可用）都静默返回。
 * @param {'click'|'board'|'illegal'|'undo'|'lose'|'win'} name
 */
export function playSound(name) {
  if (muted) return;
  try {
    const now = performance.now();
    if (lastPlay[name] && now - lastPlay[name] < 90) return; // 防叠加
    lastPlay[name] = now;
    if (!ensureCtx()) return;
    if (ctx.state !== 'running') return; // 尚未解锁：跳过而非报错
    SFX[name]?.();
  } catch { /* 音效失败不影响游戏逻辑 */ }
}

/* ---------------- 点击音效候选（试听选择器） ----------------
 * 六种方案在波形 / 音高轨迹 / 包络 / 节奏结构上均有明显区别。
 * play() 内部全部使用 track:true，保证试听可随时被中止。 */
export const CLICK_CANDIDATES = [
  {
    id: 'A',
    name: '清脆轻点',
    desc: '短促干净的高音正弦轻点，轻盈利落，适合高频操作',
    play() {
      tone(1250, 0.05, { type: 'sine', gain: 0.12, track: true });
      tone(1800, 0.03, { type: 'sine', gain: 0.05, when: 0.008, track: true });
    },
  },
  {
    id: 'B',
    name: '柔和木质',
    desc: '低音三角波下扫 + 轻噪声瞬态，像指尖敲木块，温暖圆润',
    play() {
      noiseKnock(0.05, { gain: 0.1, freq: 900, track: true });
      tone(330, 0.1, { type: 'triangle', gain: 0.14, sweepTo: 240, track: true });
    },
  },
  {
    id: 'C',
    name: '软弹反馈',
    desc: '音高先扬后抑的小弧线，带一点 Q 弹回弹感，活泼不卡通',
    play() {
      tone(300, 0.16, { type: 'sine', gain: 0.13, sweepTo: 520, sweep2: { at: 0.05, to: 340 }, track: true });
    },
  },
  {
    id: 'D',
    name: '电子确认',
    desc: '两声紧凑方波（880→1320Hz），清晰的数字产品确认感',
    play() {
      tone(880, 0.045, { type: 'square', gain: 0.05, track: true });
      tone(1320, 0.05, { type: 'square', gain: 0.045, when: 0.045, track: true });
    },
  },
  {
    id: 'E',
    name: '轻快双音',
    desc: '上行五度双音（660→990Hz），辨识度高，整体仍短促',
    play() {
      tone(660, 0.06, { type: 'triangle', gain: 0.11, track: true });
      tone(990, 0.07, { type: 'triangle', gain: 0.11, when: 0.075, track: true });
    },
  },
  {
    id: 'F',
    name: '柔和气泡',
    desc: '低音上扫的圆润「啵」声 + 极轻噪声，细腻气泡质感',
    play() {
      tone(420, 0.11, { type: 'sine', gain: 0.11, sweepTo: 940, track: true });
      noiseKnock(0.06, { gain: 0.03, freq: 2200, when: 0.01, track: true });
    },
  },
];

/**
 * 试听候选音效（通用内部实现）。
 * - 自动停止上一段试听（快速切换不叠加，点击/移动两类候选互斥）；
 * - 不受 playSound 的 90ms 去重限制（重复试听同一方案也应立即发声）；
 * - 尊重全局静音；自动解锁 AudioContext（等待 resume 完成，保证
 *   首次点击也能出声）；
 * @returns {Promise<boolean>} 是否实际发出了声音
 */
async function previewCandidate(list, id) {
  try {
    const c = list.find((k) => k.id === id);
    stopPreview();
    if (!c || muted) return false;
    if (!ensureCtx()) return false;
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch { /* 忽略 */ }
    }
    if (ctx.state !== 'running') return false;
    c.play();
    return true;
  } catch {
    return false; // 试听失败绝不影响调用方
  }
}

/** 试听点击音效候选。 */
export function previewClick(id) {
  return previewCandidate(CLICK_CANDIDATES, id);
}

/** 停止当前试听（页面卸载/离开时使用）。 */
export function stopClickPreview() {
  stopPreview();
}

/** 读取已保存的点击音效选择（可能为 null = 尚未选择）。 */
export function getClickChoice() {
  return getChoice(CLICK_CHOICE_KEY, CLICK_CANDIDATES);
}

/** 保存点击音效选择（试听选择器用；确认后再接入主游戏）。 */
export function setClickChoice(id) {
  setChoice(CLICK_CHOICE_KEY, CLICK_CANDIDATES, id);
}

function getChoice(key, list) {
  try {
    const v = localStorage.getItem(key);
    return list.some((c) => c.id === v) ? v : null;
  } catch {
    return null;
  }
}

function setChoice(key, list, id) {
  try {
    if (list.some((c) => c.id === id)) {
      localStorage.setItem(key, id);
    }
  } catch { /* 忽略存储失败 */ }
}

export function isMuted() {
  return muted;
}

/** 切换静音并持久化。 */
export function setMuted(v) {
  muted = !!v;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch { /* 忽略存储失败 */ }
}

export function getVolume() {
  return volume;
}

/** 设置全局音量 0..1 并持久化（作用于主游戏与试听）。 */
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, Number(v) || 0));
  if (masterGain) masterGain.gain.value = volume;
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch { /* 忽略存储失败 */ }
}
