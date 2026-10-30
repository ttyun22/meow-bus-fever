/**
 * 统一音频管理器（音乐 / 音效完全分离）
 * ------------------------------------------------------------
 * 设计目标（按手机端优先级）：
 *  1. iOS / Android / 微信内置浏览器的「系统静音」只对媒体元素
 *     （HTMLAudioElement）有可靠约束；Web Audio 在 iOS 上通常会绕过
 *     静音开关。因此主游戏统一使用 <audio> 播放，不调用 AudioContext，
 *     也不设置 audioSession 等播放通道，尽可能尊重设备静音。
 *  2. BGM 全程只有一个 Audio 实例，切换关卡、重开、返回首页都不会
 *     重复创建或叠加播放；音乐开关直接 pause()，立即停止。
 *  3. SFX 使用固定数量的预渲染短音频元素（每个音效一个），不重复创建；
 *     音效开关为 true 时直接跳过播放，并在关闭瞬间暂停所有正在响的音。
 *  4. 所有浏览器拦截 / 解码失败 / 隐私模式异常都静默降级，不影响玩法。
 *
 * 兼容性说明：浏览器无权读取系统静音开关，也无法强制系统扬声器静音。
 * 使用媒体元素是本项目能做到的「最尊重系统设置」的方式；游戏内仍提供
 * 独立且可靠的音乐、音效开关。
 */

const MUTE_KEY = 'bus-sound-muted';
const VOLUME_KEY = 'bus-sound-volume';
const CLICK_CHOICE_KEY = 'bus-click-sound-v1';
const BGM_MUTE_KEY = 'bus-bgm-muted';
const BGM_VOLUME_KEY = 'bus-bgm-volume';

/** 本地 BGM：优先 AAC（约 260KB），不支持时自动回退 WAV。 */
const BGM_URLS = [
  new URL('../../assets/bgm-cat-bus.m4a', import.meta.url).href,
  new URL('../../assets/bgm-cat-bus.wav', import.meta.url).href,
];

let muted = false;
let volume = 1;
let bgmMuted = false;
let bgmVolume = 0.32;

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
  bgmMuted = localStorage.getItem(BGM_MUTE_KEY) === '1';
  const bv = parseFloat(localStorage.getItem(BGM_VOLUME_KEY));
  if (Number.isFinite(bv)) bgmVolume = Math.min(1, Math.max(0, bv));
} catch { /* 隐私模式等场景下忽略 */ }

/* ================= 轻量 PCM 合成 =================
 * 把原来的 Web Audio 音效渲染成短 WAV data URI，再由媒体元素播放。
 * 只在首次用户手势时生成，之后复用缓存，不产生额外音频实例。 */

const SAMPLE_RATE = 22050;
const sfxUris = new Map();
const sfxEls = new Map();
const lastPlay = {};

const SFX_SPECS = {
  click: [
    { freq: 700, dur: 0.06, type: 'square', gain: 0.045 },
  ],
  board: [
    { freq: 620, dur: 0.09, type: 'sine', gain: 0.1 },
  ],
  illegal: [
    { freq: 180, dur: 0.12, type: 'sawtooth', gain: 0.09 },
    { freq: 150, dur: 0.12, type: 'sawtooth', gain: 0.07, when: 0.1 },
  ],
  undo: [
    { freq: 500, dur: 0.07, type: 'sine', gain: 0.08 },
    { freq: 380, dur: 0.1, type: 'sine', gain: 0.08, when: 0.07 },
  ],
  lose: [
    { freq: 440, dur: 0.22, type: 'triangle', gain: 0.1 },
    { freq: 330, dur: 0.22, type: 'triangle', gain: 0.1, when: 0.16 },
    { freq: 220, dur: 0.22, type: 'triangle', gain: 0.1, when: 0.32 },
  ],
  win: [
    { freq: 523, dur: 0.18, type: 'triangle', gain: 0.1 },
    { freq: 659, dur: 0.18, type: 'triangle', gain: 0.1, when: 0.12 },
    { freq: 784, dur: 0.18, type: 'triangle', gain: 0.1, when: 0.24 },
    { freq: 1047, dur: 0.18, type: 'triangle', gain: 0.1, when: 0.36 },
  ],
};

function addTone(buf, note) {
  const {
    freq, dur, type = 'sine', gain = 0.1, when = 0,
    sweepTo = null, sweep2 = null,
  } = note;
  const start = Math.floor(when * SAMPLE_RATE);
  const count = Math.max(1, Math.floor(dur * SAMPLE_RATE));
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    let f = freq;
    if (sweep2) {
      if (t < sweep2.at) {
        if (sweepTo) f = freq * Math.pow(sweepTo / freq, t / Math.max(0.001, sweep2.at));
      } else {
        const base = sweepTo ?? freq;
        const p = Math.min(1, (t - sweep2.at) / Math.max(0.001, dur - sweep2.at));
        f = base * Math.pow(sweep2.to / base, p);
      }
    } else if (sweepTo) {
      f = freq * Math.pow(sweepTo / freq, t / dur);
    }
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    let w;
    if (type === 'square') w = Math.sin(phase) >= 0 ? 1 : -1;
    else if (type === 'triangle') w = (2 / Math.PI) * Math.asin(Math.sin(phase));
    else if (type === 'sawtooth') {
      const p = phase / (2 * Math.PI);
      w = 2 * (p - Math.floor(p)) - 1;
    } else w = Math.sin(phase);
    const env = Math.min(1, t / 0.003) * Math.exp((-4.6 * t) / dur);
    buf[idx] += w * gain * env;
  }
}

function addNoise(buf, note) {
  const { dur, gain = 0.06, when = 0 } = note;
  const start = Math.floor(when * SAMPLE_RATE);
  const count = Math.max(1, Math.floor(dur * SAMPLE_RATE));
  let last = 0;
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const white = Math.random() * 2 - 1;
    // 一阶高通：让敲击声更清脆，不像低频噪声。
    const hp = white - last * 0.92;
    last = white;
    buf[idx] += hp * gain * Math.exp((-9 * t) / dur);
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
  }
  return btoa(binary);
}

function encodeWav(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  const norm = peak > 0.96 ? 0.96 / peak : 1;
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * norm));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return `data:audio/wav;base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

function renderNotes(notes) {
  let end = 0;
  for (const n of notes) end = Math.max(end, (n.when || 0) + (n.dur || 0));
  const buf = new Float32Array(Math.ceil((end + 0.06) * SAMPLE_RATE));
  for (const n of notes) {
    if (n.noise) addNoise(buf, n);
    else addTone(buf, n);
  }
  return encodeWav(buf);
}

function getSfxUri(name) {
  if (sfxUris.has(name)) return sfxUris.get(name);
  const spec = SFX_SPECS[name];
  if (!spec) return null;
  const uri = renderNotes(spec);
  sfxUris.set(name, uri);
  return uri;
}

function getSfxEl(name) {
  if (sfxEls.has(name)) return sfxEls.get(name);
  const uri = getSfxUri(name);
  if (!uri || typeof Audio === 'undefined') return null;
  try {
    const el = new Audio(uri);
    el.preload = 'auto';
    sfxEls.set(name, el);
    return el;
  } catch {
    return null;
  }
}

/* ================= BGM（单实例） ================= */

let bgmEl = null;
let bgmSrcIndex = 0;
let bgmWanted = false;
let bgmPlaying = false;
let bgmPausedByVisibility = false;
let audioUnlocked = false;

function ensureBgm() {
  if (bgmEl) return bgmEl;
  if (typeof Audio === 'undefined') return null;
  try {
    bgmEl = new Audio();
    bgmEl.loop = true;
    bgmEl.preload = 'auto';
    bgmEl.volume = bgmVolume;
    bgmEl.setAttribute('playsinline', '');
    bgmEl.src = BGM_URLS[bgmSrcIndex];
    bgmEl.addEventListener('playing', () => { bgmPlaying = true; });
    bgmEl.addEventListener('pause', () => { bgmPlaying = false; });
    bgmEl.addEventListener('ended', () => { bgmPlaying = false; });
    bgmEl.addEventListener('error', () => {
      bgmPlaying = false;
      if (bgmSrcIndex < BGM_URLS.length - 1) {
        bgmSrcIndex += 1;
        bgmEl.src = BGM_URLS[bgmSrcIndex];
        try { bgmEl.load(); } catch { /* 忽略 */ }
        if (bgmWanted && !bgmMuted) startBgm();
      }
    });
  } catch {
    bgmEl = null;
  }
  return bgmEl;
}

/** 首次手势内静音试播每个音效元素，解锁移动端媒体播放限制。 */
function primeSfx() {
  for (const name of Object.keys(SFX_SPECS)) {
    const el = getSfxEl(name);
    if (!el) continue;
    try {
      el.muted = true;
      const p = el.play();
      const restore = () => {
        try {
          el.pause();
          el.currentTime = 0;
        } catch { /* 忽略 */ }
        el.muted = false;
      };
      if (p && typeof p.then === 'function') p.then(restore, () => { el.muted = false; });
      else restore();
    } catch {
      el.muted = false;
    }
  }
}

/** 当前环境是否具备媒体播放能力（试听页据此给出提示）。 */
export function isAudioSupported() {
  return typeof Audio !== 'undefined';
}

/**
 * 首次用户手势时调用：解锁媒体播放，并在允许时启动 BGM。
 * 重复调用安全：BGM 只有一个实例，play() 已在播放时不会叠加。
 */
export function unlockAudio(autoStart = true) {
  const first = !audioUnlocked;
  audioUnlocked = true;
  if (first) primeSfx();
  if (autoStart && !bgmMuted) startBgm();
}

/** 首屏空闲时只预加载 BGM，不播放、不创建额外实例。 */
export function preloadBgm() {
  if (bgmMuted) return;
  setTimeout(() => {
    const el = ensureBgm();
    if (el && el.readyState === 0) {
      try { el.load(); } catch { /* 忽略 */ }
    }
  }, 0);
}

/** 播放主游戏事件音效。关闭音效时直接返回；播放失败静默忽略。 */
export function playSound(name) {
  if (muted) return;
  try {
    const now = performance.now();
    if (lastPlay[name] && now - lastPlay[name] < 90) return; // 防连点叠加
    lastPlay[name] = now;
    const el = getSfxEl(name);
    if (!el) return;
    try { el.pause(); } catch { /* 忽略 */ }
    try { el.currentTime = 0; } catch { /* 元数据尚未加载 */ }
    try { el.volume = volume; } catch { /* iOS 忽略 volume */ }
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 音效失败不影响游戏逻辑 */ }
}

/** 启动 BGM：已播放时直接返回，绝不叠加第二条音乐。 */
export function startBgm() {
  if (bgmMuted) {
    bgmWanted = false;
    return;
  }
  bgmWanted = true;
  const el = ensureBgm();
  if (!el) return;
  if (!el.paused) {
    bgmPlaying = true;
    return;
  }
  try {
    el.volume = bgmVolume;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => { bgmPlaying = false; });
  } catch {
    bgmPlaying = false;
  }
}

/** 停止 BGM：立即 pause，不销毁共享实例，也不影响任何音效。 */
export function stopBgm() {
  bgmWanted = false;
  bgmPlaying = false;
  if (!bgmEl) return;
  try { bgmEl.pause(); } catch { /* 忽略 */ }
}

export function isBgmMuted() {
  return bgmMuted;
}

/** 单独开关 BGM 并持久化；不会影响任何 SFX。 */
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

/** 设置 BGM 音量并持久化；iOS 会忽略 volume，属浏览器限制。 */
export function setBgmVolume(v) {
  bgmVolume = Math.min(1, Math.max(0, Number(v) || 0));
  if (bgmEl) {
    try { bgmEl.volume = bgmVolume; } catch { /* iOS 忽略 */ }
  }
  try {
    localStorage.setItem(BGM_VOLUME_KEY, String(bgmVolume));
  } catch { /* 忽略存储失败 */ }
}

export function isBgmPlaying() {
  return !!(bgmEl && !bgmEl.paused && !bgmMuted);
}

/** 调试/验收用：当前 BGM 播放状态。 */
export function getBgmMode() {
  return isBgmPlaying() ? 'file' : 'stopped';
}

/* 切换标签页/最小化时暂停 BGM，回来再恢复；不重复创建实例。 */
if (typeof document !== 'undefined' && !window.__busBgmVisibilityBound) {
  window.__busBgmVisibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (bgmEl && !bgmEl.paused) {
        bgmPausedByVisibility = true;
        try { bgmEl.pause(); } catch { /* 忽略 */ }
      }
    } else if (bgmPausedByVisibility) {
      bgmPausedByVisibility = false;
      if (!bgmMuted && bgmWanted) startBgm();
    }
  });
}

/* 任何一次后续触摸都允许重试：解决首次手势时媒体尚未解锁的问题。 */
if (typeof window !== 'undefined' && !window.__busBgmGestureBound) {
  window.__busBgmGestureBound = true;
  window.addEventListener('pointerdown', () => {
    if (bgmWanted && !bgmMuted && !isBgmPlaying()) startBgm();
  }, { passive: true });
}

/* ================= 点击音效候选（试听选择器） =================
 * 每个候选都是一段独立的短 WAV，统一走同一个预览媒体元素；
 * 试听互斥、可随时停止，关闭全局音效时同样静默。 */

export const CLICK_CANDIDATES = [
  {
    id: 'A',
    name: '清脆轻点',
    desc: '短促干净的高音正弦轻点，轻盈利落，适合高频操作',
    notes: [
      { freq: 1250, dur: 0.05, type: 'sine', gain: 0.12 },
      { freq: 1800, dur: 0.03, type: 'sine', gain: 0.05, when: 0.008 },
    ],
  },
  {
    id: 'B',
    name: '柔和木质',
    desc: '低音三角波下扫 + 轻噪声瞬态，像指尖敲木块，温暖圆润',
    notes: [
      { noise: true, dur: 0.05, gain: 0.1 },
      { freq: 330, dur: 0.1, type: 'triangle', gain: 0.14, sweepTo: 240 },
    ],
  },
  {
    id: 'C',
    name: '软弹反馈',
    desc: '音高先扬后抑的小弧线，带一点 Q 弹回弹感，活泼不卡通',
    notes: [
      { freq: 300, dur: 0.16, type: 'sine', gain: 0.13, sweepTo: 520, sweep2: { at: 0.05, to: 340 } },
    ],
  },
  {
    id: 'D',
    name: '电子确认',
    desc: '两声紧凑方波（880→1320Hz），清晰的数字产品确认感',
    notes: [
      { freq: 880, dur: 0.045, type: 'square', gain: 0.05 },
      { freq: 1320, dur: 0.05, type: 'square', gain: 0.045, when: 0.045 },
    ],
  },
  {
    id: 'E',
    name: '轻快双音',
    desc: '上行五度双音（660→990Hz），辨识度高，整体仍短促',
    notes: [
      { freq: 660, dur: 0.06, type: 'triangle', gain: 0.11 },
      { freq: 990, dur: 0.07, type: 'triangle', gain: 0.11, when: 0.075 },
    ],
  },
  {
    id: 'F',
    name: '柔和气泡',
    desc: '低音上扫的圆润「啵」声 + 极轻噪声，细腻气泡质感',
    notes: [
      { freq: 420, dur: 0.11, type: 'sine', gain: 0.11, sweepTo: 940 },
      { noise: true, dur: 0.06, gain: 0.03, when: 0.01 },
    ],
  },
];

const previewUris = new Map();
let previewEl = null;

function getPreviewEl() {
  if (previewEl) return previewEl;
  if (typeof Audio === 'undefined') return null;
  try {
    previewEl = new Audio();
    previewEl.preload = 'auto';
  } catch {
    previewEl = null;
  }
  return previewEl;
}

function getPreviewUri(id) {
  if (previewUris.has(id)) return previewUris.get(id);
  const c = CLICK_CANDIDATES.find((k) => k.id === id);
  if (!c) return null;
  const uri = renderNotes(c.notes);
  previewUris.set(id, uri);
  return uri;
}

async function previewCandidate(list, id) {
  try {
    const c = list.find((k) => k.id === id);
    if (!c || muted) return false;
    const el = getPreviewEl();
    const uri = getPreviewUri(id);
    if (!el || !uri) return false;
    el.pause();
    el.currentTime = 0;
    el.src = uri;
    el.volume = volume;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      await p;
    }
    return true;
  } catch {
    return false; // 试听失败绝不影响调用方
  }
}

export function previewClick(id) {
  return previewCandidate(CLICK_CANDIDATES, id);
}

export function stopClickPreview() {
  if (!previewEl) return;
  try {
    previewEl.pause();
    previewEl.currentTime = 0;
  } catch { /* 忽略 */ }
}

export function getClickChoice() {
  return getChoice(CLICK_CHOICE_KEY, CLICK_CANDIDATES);
}

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
    if (list.some((c) => c.id === id)) localStorage.setItem(key, id);
  } catch { /* 忽略存储失败 */ }
}

export function isMuted() {
  return muted;
}

/** 切换音效开关并持久化；关闭瞬间暂停所有正在播放的音效。 */
export function setMuted(v) {
  muted = !!v;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch { /* 忽略存储失败 */ }
  if (muted) {
    for (const el of sfxEls.values()) {
      try {
        el.pause();
        el.currentTime = 0;
      } catch { /* 忽略 */ }
    }
    stopClickPreview();
  }
}

export function getVolume() {
  return volume;
}

/** 设置音效音量并持久化（iOS 会忽略媒体元素 volume，属系统限制）。 */
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, Number(v) || 0));
  for (const el of sfxEls.values()) {
    try { el.volume = volume; } catch { /* 忽略 */ }
  }
  if (previewEl) {
    try { previewEl.volume = volume; } catch { /* 忽略 */ }
  }
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch { /* 忽略存储失败 */ }
}