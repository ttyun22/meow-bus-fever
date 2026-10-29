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
const BGM_MUTE_KEY = 'bus-bgm-muted';
const BGM_VOLUME_KEY = 'bus-bgm-volume';

/**
 * 本地 BGM。
 * 主文件为 64 kbps AAC（约 260 KB），WAV 作为不支持 AAC 时的兜底。
 * 由 tools/generate-bgm.py 纯合成生成，无版权/外链/网络依赖；
 * 使用 decodeAudioData + loop=true 播放，循环点由音频采样精确控制。
 */
const BGM_URLS = [
  new URL('../../assets/bgm-cat-bus.m4a', import.meta.url).href,
  new URL('../../assets/bgm-cat-bus.wav', import.meta.url).href,
];

let ctx = null;
let ctxFailed = false;
let ctxUnlocked = false;
let muted = false;
let volume = 1;
let masterGain = null;
const lastPlay = {};

/* BGM 独立于 SFX：自己的 gain、自己的开关/音量，不经过 masterGain，
   因此关闭背景音乐不会影响点击、上车、胜利等游戏音效。 */
let bgmMuted = false;
let bgmVolume = 0.32;
let bgmGain = null;
let bgmDuckGain = null;
let bgmPlaying = false;
let bgmStarting = false;
let bgmWanted = false;
let bgmTimer = null;
let bgmSource = null;
let bgmBuffer = null;
let bgmBufferPromise = null;
let bgmData = null;
let bgmDataPromise = null;
let bgmUsesFile = false;
let bgmPausedByVisibility = false;
let bgmStep = 0;
let bgmNextTime = 0;
let bgmDuckTimer = null;

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
  bgmMuted = localStorage.getItem(BGM_MUTE_KEY) === '1';
  const bv = parseFloat(localStorage.getItem(BGM_VOLUME_KEY));
  if (Number.isFinite(bv)) bgmVolume = Math.min(1, Math.max(0, bv));
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
    bgmGain = ctx.createGain();
    bgmGain.gain.value = 0.0001;
    // 独立 duck 级：播放 SFX 时轻轻压低 BGM，保证点击/上车/发车音清晰。
    bgmDuckGain = ctx.createGain();
    bgmDuckGain.gain.value = 1;
    bgmGain.connect(bgmDuckGain).connect(ctx.destination);
  } catch {
    ctxFailed = true;
    return null;
  }
  return ctx;
}

/**
 * 在首个用户手势内播一个 1 sample 的静音 buffer。
 * iOS Safari / 微信 WKWebView 对 Web Audio 的解锁比单纯 resume() 更严格，
 * 这一步能显著提高「点击开始后 BGM 真的出声」的成功率。
 */
function primeAudio(c) {
  if (ctxUnlocked) return;
  try {
    const buffer = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    src.start(0);
    ctxUnlocked = true;
  } catch { /* 静默失败，不影响游戏 */ }
}

/**
 * 首次用户手势时调用：解锁自动播放限制，并在允许时启动 BGM。
 * 重复调用是安全的：startBgm 有 bgmPlaying / bgmStarting 双重保护。
 */
export function unlockAudio(autoStart = true) {
  const c = ensureCtx();
  if (!c) return;
  const kick = () => {
    primeAudio(c);
    if (autoStart && !bgmMuted) startBgm();
  };
  if (c.state === 'suspended') {
    c.resume().then(kick).catch(() => {});
  } else {
    kick();
  }
}

/**
 * 解码 BGM 字节。Safari 旧版只支持回调形式，两种都包一层。
 */
function decodeAudio(c, data) {
  return new Promise((resolve, reject) => {
    const ret = c.decodeAudioData(data, resolve, reject);
    if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
  });
}

/**
 * 下载 BGM 原始字节。预取阶段不创建 AudioContext，避免 iOS / 微信
 * 在用户手势前就把音频上下文锁死；真正 decode 等到点击开始后再做。
 */
function loadBgmBytes() {
  if (bgmData) return Promise.resolve(bgmData);
  if (bgmDataPromise) return bgmDataPromise;
  bgmDataPromise = (async () => {
    for (const url of BGM_URLS) {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) continue;
        const data = await res.arrayBuffer();
        if (data.byteLength > 0) {
          bgmData = data;
          return data;
        }
      } catch { /* 尝试下一个格式 */ }
    }
    bgmDataPromise = null; // 允许网络恢复后重试
    return null;
  })();
  return bgmDataPromise;
}

function loadBgmBuffer() {
  if (bgmBuffer) return Promise.resolve(bgmBuffer);
  if (bgmBufferPromise) return bgmBufferPromise;
  const c = ensureCtx();
  if (!c) return Promise.resolve(null);
  bgmBufferPromise = (async () => {
    const data = await loadBgmBytes();
    if (!data) return null;
    try {
      const buffer = await decodeAudio(c, data);
      if (buffer && buffer.duration > 0) {
        bgmBuffer = buffer;
        return buffer;
      }
    } catch { /* 交给程序化合成兜底 */ }
    bgmBufferPromise = null;
    return null;
  })();
  return bgmBufferPromise;
}

/** 首屏只预取压缩后的 BGM 字节，不创建 AudioContext、不播放。 */
export function preloadBgm() {
  if (bgmMuted) return;
  // 让首帧先绘制，再异步 fetch；点击「开始游戏」时通常已下载完成。
  setTimeout(() => loadBgmBytes(), 0);
}

/** 播放 SFX 时短暂压低 BGM，避免旋律盖住操作反馈。 */
function duckBgm() {
  if (!ctx || !bgmDuckGain || !bgmPlaying) return;
  const now = ctx.currentTime;
  bgmDuckGain.gain.cancelScheduledValues(now);
  bgmDuckGain.gain.setTargetAtTime(0.42, now, 0.012);
  clearTimeout(bgmDuckTimer);
  bgmDuckTimer = setTimeout(() => {
    if (!ctx || !bgmDuckGain) return;
    const t = ctx.currentTime;
    bgmDuckGain.gain.cancelScheduledValues(t);
    bgmDuckGain.gain.setTargetAtTime(1, t, 0.2);
  }, 180);
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
    duckBgm();
    SFX[name]?.();
  } catch { /* 音效失败不影响游戏逻辑 */ }
}

/* ================= 循环 BGM =================
 * 主方案：assets/bgm-cat-bus.wav（本地合成、无版权/外链）。
 * 114 BPM、16 小节，C 大调五声音阶，木琴 + 玩具拨弦 + 轻打击，
 * 比旧版 84 BPM 的慢速铺底更活泼、更俏皮；音量低于 SFX，并在
 * 每次操作音播放时自动 duck 一下，保证点击/上车/发车音清晰可辨。
 *
 * 兜底方案：若浏览器无法解码 WAV，则使用下面的程序化合成循环。
 * 两条路径共用 bgmGain，且都有 bgmPlaying / bgmStarting 双重保护，
 * 切换关卡、重复点击都不会叠加第二个音乐实例。
 */
const BGM_TEMPO = 114;
const BGM_STEP = 60 / BGM_TEMPO / 2; // 八分音符
const BGM_STEPS_PER_BAR = 8;
const BGM_BARS = 8;
const BGM_LOOP_STEPS = BGM_STEPS_PER_BAR * BGM_BARS;
const BGM_LOOKAHEAD = 0.35;
const BGM_TICK_MS = 80;

const midiHz = (n) => 440 * 2 ** ((n - 69) / 12);

/** 兜底合成：8 小节 C → Am → F → G → C → Em → F → G。 */
const BGM_CHORDS = [
  { bass: 48, chord: [60, 64, 67, 72], motif: [72, 76, 79, 76] },
  { bass: 45, chord: [57, 60, 64, 69], motif: [69, 72, 76, 74] },
  { bass: 41, chord: [53, 57, 60, 65], motif: [72, 77, 81, 77] },
  { bass: 43, chord: [55, 59, 62, 67], motif: [74, 79, 83, 79] },
  { bass: 48, chord: [60, 64, 67, 72], motif: [76, 79, 84, 79] },
  { bass: 40, chord: [52, 55, 59, 64], motif: [71, 76, 79, 76] },
  { bass: 41, chord: [53, 57, 60, 65], motif: [77, 81, 84, 81] },
  { bass: 43, chord: [55, 59, 62, 67], motif: [79, 83, 86, 79] },
];

function bgmTone(midi, when, duration, gain = 0.05, type = 'triangle') {
  if (!ctx || !bgmGain) return;
  const t0 = when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3200, t0);
  filter.frequency.exponentialRampToValueAtTime(1000, t0 + duration);
  osc.type = type;
  osc.frequency.setValueAtTime(midiHz(midi), t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(filter).connect(g).connect(bgmGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function bgmPad(midis, when, duration) {
  for (const midi of midis) {
    if (!ctx || !bgmGain) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(midiHz(midi - 12), when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.012, when + 0.13);
    g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(g).connect(bgmGain);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }
}

/** 兜底合成的一个八分音符步骤：低音 + 反拍和弦 + 木琴旋律。 */
function scheduleBgmStep(step, when) {
  const bar = Math.floor(step / BGM_STEPS_PER_BAR) % BGM_BARS;
  const beat = step % BGM_STEPS_PER_BAR;
  const chord = BGM_CHORDS[bar];

  if (beat === 0) bgmTone(chord.bass, when, 0.52, 0.055, 'triangle');
  if (beat === 3) bgmTone(chord.bass + 7, when, 0.28, 0.028, 'triangle');
  if (beat === 4) bgmTone(chord.bass, when, 0.38, 0.045, 'triangle');
  if (beat === 6) bgmTone(chord.bass + 12, when, 0.22, 0.022, 'triangle');

  if (beat === 1 || beat === 5) bgmPad(chord.chord, when, 0.75);

  const motifIndex = [0, 2, 3, 4, 6, 7].indexOf(beat);
  if (motifIndex >= 0) {
    const midi = chord.motif[(motifIndex + bar) % chord.motif.length];
    bgmTone(midi, when, 0.34, motifIndex === 0 ? 0.038 : 0.026, 'triangle');
    if (motifIndex === 0) bgmTone(midi + 12, when + 0.01, 0.22, 0.010, 'sine');
  }
}

function bgmScheduler() {
  if (!bgmPlaying || !ctx) return;
  while (bgmNextTime < ctx.currentTime + BGM_LOOKAHEAD) {
    scheduleBgmStep(bgmStep, bgmNextTime);
    bgmStep = (bgmStep + 1) % BGM_LOOP_STEPS;
    bgmNextTime += BGM_STEP;
  }
}

function stopBgmSource() {
  if (!ctx || !bgmSource) return;
  const src = bgmSource;
  bgmSource = null;
  try { src.stop(); } catch { /* 已停止 */ }
  try { src.disconnect(); } catch { /* 已断开 */ }
}

/**
 * 计算实际音频循环点：跳过编码器在首尾留下的静音 padding，
 * 避免 AAC 循环时出现约 100ms 的断点。
 */
function cyclePoints(buffer) {
  const data = buffer.getChannelData(0);
  const threshold = 0.0015;
  let start = 0;
  let end = data.length - 1;
  while (start < data.length && Math.abs(data[start]) < threshold) start += 1;
  while (end > start && Math.abs(data[end]) < threshold) end -= 1;
  if (end - start < buffer.sampleRate * 0.5) {
    return { start: 0, end: buffer.duration };
  }
  return {
    start: start / buffer.sampleRate,
    end: Math.min(buffer.duration, (end + 1) / buffer.sampleRate),
  };
}

function startBufferBgm(c, buffer) {
  stopBgmSource();
  const src = c.createBufferSource();
  const loop = cyclePoints(buffer);
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = loop.start;
  src.loopEnd = loop.end;
  src.connect(bgmGain);
  src.start(c.currentTime + 0.06);
  bgmSource = src;
  bgmUsesFile = true;
  bgmPlaying = true;
}

function startSynthBgm(c) {
  stopBgmSource();
  bgmUsesFile = false;
  bgmPlaying = true;
  bgmStep = 0;
  bgmNextTime = c.currentTime + 0.1;
  clearInterval(bgmTimer);
  bgmTimer = setInterval(bgmScheduler, BGM_TICK_MS);
  bgmScheduler();
}

/** 启动 BGM：已播放 / 启动中直接返回，绝不会叠加第二条音乐。 */
export function startBgm() {
  if (bgmMuted) {
    bgmWanted = false;
    return;
  }
  bgmWanted = true;
  if (bgmPlaying || bgmStarting) return;
  const c = ensureCtx();
  if (!c || !bgmGain) return;
  primeAudio(c);
  bgmStarting = true;
  (async () => {
    try {
      if (c.state !== 'running') {
        try { await c.resume(); } catch { /* 等下次手势 */ }
      }
      if (!bgmWanted || bgmMuted || document.hidden) return;
      if (c.state !== 'running') return;
      primeAudio(c);
      const buffer = await loadBgmBuffer();
      if (!bgmWanted || bgmMuted || document.hidden) return;
      if (c.state !== 'running') return;
      const now = c.currentTime;
      bgmGain.gain.cancelScheduledValues(now);
      bgmGain.gain.setValueAtTime(0.0001, now);
      bgmGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, bgmVolume), now + 0.8);
      if (buffer) startBufferBgm(c, buffer);
      else startSynthBgm(c);
    } finally {
      bgmStarting = false;
      // 异步加载期间若被关掉又打开，确保最终仍会播放。
      // 仅在 AudioContext 已 running 时重试，避免自动播放被拒后无限重试。
      if (bgmWanted && !bgmMuted && !bgmPlaying && !document.hidden && c.state === 'running') {
        setTimeout(() => {
          if (bgmWanted && !bgmMuted && !bgmPlaying) startBgm();
        }, 0);
      }
    }
  })();
}

/** 停止 BGM：淡出并停止当前音源，不销毁共享 AudioContext / SFX 总线。 */
export function stopBgm() {
  bgmWanted = false;
  bgmPlaying = false;
  bgmUsesFile = false;
  clearInterval(bgmTimer);
  bgmTimer = null;
  if (ctx && bgmGain) {
    const now = ctx.currentTime;
    bgmGain.gain.cancelScheduledValues(now);
    bgmGain.gain.setValueAtTime(Math.max(0.0001, bgmGain.gain.value), now);
    bgmGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  }
  if (!ctx || !bgmSource) return;
  // 保留引用到 onended：若用户很快再次开启，startBufferBgm 会立即
  // stopBgmSource()，避免旧循环和新循环短暂叠加。
  const src = bgmSource;
  const stopAt = ctx.currentTime + 0.19;
  try { src.stop(stopAt); } catch { /* 已停止 */ }
  src.onended = () => {
    if (bgmSource === src) bgmSource = null;
    try { src.disconnect(); } catch { /* 已断开 */ }
  };
}

export function isBgmMuted() {
  return bgmMuted;
}

/** 单独开关 BGM 并持久化；不会影响 any SFX。 */
export function setBgmMuted(v) {
  bgmMuted = !!v;
  try {
    localStorage.setItem(BGM_MUTE_KEY, bgmMuted ? '1' : '0');
  } catch { /* 忽略存储失败 */ }
  if (bgmMuted) stopBgm();
  else startBgm();
}

export function toggleBgm() {
  setBgmMuted(!bgmMuted);
  return !bgmMuted;
}

export function getBgmVolume() {
  return bgmVolume;
}

/** 设置 BGM 音量 0..1 并持久化；默认 0.32，明显低于 SFX。 */
export function setBgmVolume(v) {
  bgmVolume = Math.min(1, Math.max(0, Number(v) || 0));
  if (bgmGain && bgmPlaying) {
    const now = ctx.currentTime;
    bgmGain.gain.cancelScheduledValues(now);
    bgmGain.gain.setTargetAtTime(Math.max(0.0001, bgmVolume), now, 0.08);
  }
  try {
    localStorage.setItem(BGM_VOLUME_KEY, String(bgmVolume));
  } catch { /* 忽略存储失败 */ }
}

export function isBgmPlaying() {
  return bgmPlaying;
}

/** 调试/验收用：当前 BGM 实际走的是本地音频还是合成兜底。 */
export function getBgmMode() {
  if (!bgmPlaying) return 'stopped';
  return bgmUsesFile ? 'file' : 'synth';
}

/* 切换标签页/最小化时暂停 BGM，回来再恢复；不会重复创建音乐实例。 */
if (typeof document !== 'undefined' && !window.__busBgmVisibilityBound) {
  window.__busBgmVisibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (bgmPlaying || bgmWanted || bgmStarting) {
        bgmPausedByVisibility = true;
        stopBgm();
      }
    } else if (bgmPausedByVisibility) {
      bgmPausedByVisibility = false;
      if (!bgmMuted) startBgm();
    }
  });
}

/* 任何一次后续触摸都允许重试：解决 iOS/微信首次手势时
   AudioContext 尚未 running 导致 BGM 没启动的问题。 */
if (typeof window !== 'undefined' && !window.__busBgmGestureBound) {
  window.__busBgmGestureBound = true;
  window.addEventListener('pointerdown', () => {
    if (bgmWanted && !bgmMuted && !bgmPlaying) startBgm();
  }, { passive: true });
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
