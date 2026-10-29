/**
 * 渲染层：把 state 映射为 DOM。
 * ------------------------------------------------------------
 * 视觉素材全部为内联 SVG（原创、无外部资源、断网可用）：
 *  - 巴士：统一的 2.5D 玩具公交（车身/车窗/车轮/车顶设备/高光/阴影），
 *    车顶为「深色描边 + 粗白箭头」的驶出方向标识；
 *  - 猫咪：圆润的猫咪头（耳朵、双眼、鼻子、嘴、腮红、胡须），
 *    只用轻量浮动/眨眼/补位/弹跳缩小动画，不做身体或骨骼动画；
 *  - 停车场：沥青地面 + 车位线 + 污渍 + 边缘路缘，车辆密集但边界清楚。
 *
 * DOM 契约（controller.js 动画依赖，修改时必须保持）：
 *  - .bus（格区点击热区）/ .bus-inner（车身，闪烁反馈目标）
 *  - .passenger（含 .head 队首，走路/上车动画载体）
 *  - .slot-bus（含 data-slot-bus，发车/弹跳动画载体）
 *  - .slot-load（只出现在接客位上的载客进度）
 */
import { buildOccupancy, pathIsClear, exitPathOfBus } from '../game/logic.js';

/* ================ SVG 素材（原创，无外部依赖） ================ */

/**
 * 2.5D 玩具公交 · 默认朝右。
 * viewBox 比例严格为「车长 : 车宽 = len : 1」，与占用格一致。
 * 统一透视：车头在右，车尾在左；同一套高光/阴影/材质用于所有车辆。
 */
export function busSvgMarkup(len, opts = {}) {
  const W = 100 * len;
  const H = 100;
  const style = opts.style || '';
  const bodyX = 8;
  const bodyW = W - 16;
  const windowTop = 18;
  const windowBottom = 74;
  const glassCount = Math.max(2, len * 2 - 1);
  const glassStart = 30;
  const glassEnd = W - 38;
  const glassGap = 4;
  const glassW = Math.max(4, (glassEnd - glassStart - glassGap * (glassCount - 1)) / glassCount);
  const glassRects = [];
  for (let i = 0; i < glassCount; i++) {
    const x = glassStart + i * (glassW + glassGap);
    glassRects.push(
      `<rect class="bus-window" x="${x.toFixed(1)}" y="${windowTop}" width="${glassW.toFixed(1)}" height="8" rx="3.2"/>` +
      `<rect class="bus-window" x="${x.toFixed(1)}" y="${windowBottom}" width="${glassW.toFixed(1)}" height="8" rx="3.2"/>`
    );
  }

  // 车顶箭头：粗白箭头 + 深色描边；几何中心偏向车头，避免压住挡风玻璃
  const ax = Math.min(W - 74, Math.max(W * 0.5, 92));
  const arrow = [
    `M ${ax - 26} 40`,
    `H ${ax + 2}`,
    `V 27`,
    `L ${ax + 34} 50`,
    `L ${ax + 2} 73`,
    `V 60`,
    `H ${ax - 26}`,
    'Z',
  ].join(' ');

  const acW = Math.min(30, Math.max(20, len * 15));
  const acX = 28;

  return `<svg class="bus-svg" viewBox="0 0 ${W} ${H}"${style ? ` style="${style}"` : ''} aria-hidden="true">
    <!-- 落地阴影 + 车轮（先画，车身压住内侧） -->
    <ellipse class="bus-ground-shadow" cx="${W / 2}" cy="89" rx="${W * 0.44}" ry="8"/>
    <g class="bus-wheels">
      <rect class="bus-wheel" x="${W * 0.18}" y="4" width="26" height="16" rx="7"/>
      <rect class="bus-wheel" x="${W * 0.72}" y="4" width="26" height="16" rx="7"/>
      <rect class="bus-wheel" x="${W * 0.18}" y="80" width="26" height="16" rx="7"/>
      <rect class="bus-wheel" x="${W * 0.72}" y="80" width="26" height="16" rx="7"/>
      <circle class="bus-hub" cx="${W * 0.18 + 13}" cy="12" r="4"/>
      <circle class="bus-hub" cx="${W * 0.72 + 13}" cy="12" r="4"/>
      <circle class="bus-hub" cx="${W * 0.18 + 13}" cy="88" r="4"/>
      <circle class="bus-hub" cx="${W * 0.72 + 13}" cy="88" r="4"/>
    </g>

    <!-- 车身主体 -->
    <rect class="bus-body" x="${bodyX}" y="9" width="${bodyW}" height="82" rx="19"/>
    <rect class="bus-body-shade" x="${bodyX}" y="68" width="${bodyW}" height="23" rx="17"/>
    <rect class="bus-body-rim" x="${bodyX + 2.2}" y="11.2" width="${bodyW - 4.4}" height="77.6" rx="16.8"/>

    <!-- 车顶内嵌板 -->
    <rect class="bus-roof" x="18" y="25" width="${W - 36}" height="50" rx="15"/>
    <path class="bus-roof-ridge" d="M 28 33 H ${W - 44}"/>
    <path class="bus-roof-ridge soft" d="M 28 67 H ${W - 50}"/>

    <!-- 两侧车窗（内嵌在车身边缘，形成玩具公交的“腰线”） -->
    ${glassRects.join('')}

    <!-- 前后灯、保险杠、后视镜 -->
    <rect class="bus-bumper" x="${bodyX - 1}" y="14" width="7" height="72" rx="3.5"/>
    <rect class="bus-bumper" x="${W - bodyX - 6}" y="14" width="7" height="72" rx="3.5"/>
    <circle class="bus-lamp" cx="${W - 12}" cy="23" r="5.2"/>
    <circle class="bus-lamp" cx="${W - 12}" cy="77" r="5.2"/>
    <circle class="bus-lamp-glow" cx="${W - 12}" cy="23" r="8"/>
    <circle class="bus-lamp-glow" cx="${W - 12}" cy="77" r="8"/>
    <circle class="bus-taillight" cx="12" cy="23" r="4.2"/>
    <circle class="bus-taillight" cx="12" cy="77" r="4.2"/>
    <path class="bus-mirror" d="M ${W - 16} 11 q 7 -5 10 1 q -5 2 -7 5"/>
    <path class="bus-mirror" d="M ${W - 16} 89 q 7 5 10 -1 q -5 -2 -7 -5"/>

    <!-- 挡风玻璃（车头端），带高光 -->
    <path class="bus-windshield" d="M ${W - 35} 25 Q ${W - 20} 50 ${W - 35} 75 L ${W - 41} 71 Q ${W - 29} 50 ${W - 41} 29 Z"/>
    <path class="bus-glass-shine" d="M ${W - 33} 29 Q ${W - 25} 44 ${W - 31} 51"/>

    <!-- 车顶设备（空调/通风口），避开箭头 -->
    <rect class="bus-ac" x="${acX}" y="37" width="${acW}" height="26" rx="8"/>
    <path class="bus-ac-vent" d="M ${acX + 5} 44 H ${acX + acW - 5} M ${acX + 5} 50 H ${acX + acW - 5} M ${acX + 5} 56 H ${acX + acW - 5}"/>
    <circle class="bus-roof-light" cx="${W - 54}" cy="34" r="3.2"/>
    <circle class="bus-roof-light" cx="${W - 54}" cy="66" r="3.2"/>

    <!-- 高光 -->
    <path class="bus-specular" d="M ${bodyX + 14} 18 Q ${bodyX + 4} 50 ${bodyX + 14} 82"/>

    <!-- 方向箭头：先深色描边，再白色填充，最后一条高光 -->
    <path class="bus-arrow-stroke" d="${arrow}"/>
    <path class="bus-arrow" d="${arrow}"/>
    <path class="bus-arrow-shine" d="M ${ax - 16} 46 H ${ax + 1} V 36 L ${ax + 18} 47"/>
  </svg>`;
}

/**
 * 圆润猫咪头（原创）：只保留耳朵、眼睛、鼻子、嘴和简单表情。
 * 颜色通过 --pc 继承（与巴士同色）；七种颜色共用同一套头型，
 * 不再拼接身体/四肢，保持轻量、统一的玩具贴纸风格。
 */
export function catSvgMarkup(opts = {}) {
  const walking = !!opts.walking;
  return `<svg class="cat-svg${walking ? ' cat-walking' : ''}" viewBox="0 0 64 62" aria-hidden="true">
    <ellipse class="cat-shadow" cx="32" cy="58" rx="20" ry="3.4"/>

    <g class="cat-head">
      <!-- 三角耳 + 内耳 -->
      <path class="cat-ear" d="M13 23 L10 5 L28 14 Z"/>
      <path class="cat-ear" d="M51 23 L54 5 L36 14 Z"/>
      <path class="cat-ear-inner" d="M16 20 L14.5 10 L24 15 Z"/>
      <path class="cat-ear-inner" d="M48 20 L49.5 10 L40 15 Z"/>

      <!-- 圆脸 + 右侧柔和阴影 -->
      <path class="cat-head-fill" d="M32 12 C47 12 56 20 55 32 C54 45 45 52 32 52 C19 52 10 45 9 32 C8 20 17 12 32 12 Z"/>
      <path class="cat-head-shade" d="M43 15 C52 21 53 35 46 45 C52 39 54 26 49 19 C47 17 45 16 43 15 Z"/>

      <!-- 额头虎斑 -->
      <path class="cat-stripe" d="M25 16.5 q7 4 14 0 M23 21 q9 4.5 18 0"/>

      <!-- 眼睛（眨眼动画作用在 .cat-eyes 上） -->
      <g class="cat-eyes">
        <ellipse class="cat-eye-white" cx="24" cy="31.5" rx="6.2" ry="7.2"/>
        <ellipse class="cat-eye-white" cx="40" cy="31.5" rx="6.2" ry="7.2"/>
        <ellipse class="cat-pupil" cx="24.8" cy="32.4" rx="2.8" ry="3.9"/>
        <ellipse class="cat-pupil" cx="39.2" cy="32.4" rx="2.8" ry="3.9"/>
        <circle class="cat-eye-shine" cx="26" cy="30.4" r="1.6"/>
        <circle class="cat-eye-shine" cx="40.4" cy="30.4" r="1.6"/>
      </g>

      <!-- 腮红、鼻子、笑嘴、胡须 -->
      <ellipse class="cat-blush" cx="15" cy="39.5" rx="4.4" ry="2.5"/>
      <ellipse class="cat-blush" cx="49" cy="39.5" rx="4.4" ry="2.5"/>
      <path class="cat-nose" d="M29.2 38.4 L34.8 38.4 L32 41.6 Z"/>
      <path class="cat-mouth" d="M32 41.6 q0 3 -3.4 3.4 M32 41.6 q0 3 3.4 3.4"/>
      <path class="cat-whisker" d="M11 36 L1.5 33.5 M11 40 L1.5 41 M53 36 L62.5 33.5 M53 40 L62.5 41"/>
    </g>
  </svg>`;
}

/** 停车场地面：沥青、车位线、路缘、油渍与轮胎痕。 */
function lotBackgroundSvg(cols, rows, cell) {
  const w = cols * cell;
  const h = rows * cell;
  const bays = [];
  for (let c = 0; c <= cols; c++) {
    bays.push(`<path d="M ${c * cell} 0 V ${h}"/>`);
  }
  for (let r = 0; r <= rows; r++) {
    bays.push(`<path d="M 0 ${r * cell} H ${w}"/>`);
  }
  const ticks = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cell;
      const y = r * cell;
      const len = Math.max(3, cell * 0.16);
      ticks.push(`<path d="M ${x + 3} ${y + len + 3} V ${y + 3} H ${x + len + 3}"/>`);
      ticks.push(`<path d="M ${x + cell - len - 3} ${y + cell - 3} H ${x + cell - 3} V ${y + cell - len - 3}"/>`);
    }
  }
  return `<svg class="lot-bg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="lot-asphalt" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#48515c"/>
        <stop offset="0.5" stop-color="#3e464f"/>
        <stop offset="1" stop-color="#343b43"/>
      </linearGradient>
      <pattern id="lot-speckle" width="18" height="18" patternUnits="userSpaceOnUse">
        <circle cx="3" cy="5" r="1" fill="#ffffff" opacity="0.035"/>
        <circle cx="13" cy="12" r="0.8" fill="#000000" opacity="0.12"/>
        <circle cx="8" cy="2" r="0.7" fill="#ffffff" opacity="0.03"/>
      </pattern>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#lot-asphalt)"/>
    <rect width="${w}" height="${h}" fill="url(#lot-speckle)"/>
    <g class="lot-bays" stroke="rgba(255,255,255,.13)" stroke-width="1.1" fill="none">${bays.join('')}</g>
    <g class="lot-ticks" stroke="rgba(255,209,102,.22)" stroke-width="1.4" fill="none" stroke-linecap="round">${ticks.join('')}</g>
    <path d="M ${cell * 0.5} ${h - cell * 1.7} q ${cell * 1.2} ${-cell * 0.7} ${cell * 2.2} 0" stroke="rgba(0,0,0,.18)" stroke-width="${Math.max(2, cell * 0.08)}" fill="none" stroke-linecap="round"/>
    <path d="M ${w - cell * 2.8} ${cell * 1.4} q ${cell * 1.1} ${cell * 0.5} ${cell * 2.2} 0" stroke="rgba(0,0,0,.14)" stroke-width="${Math.max(2, cell * 0.07)}" fill="none" stroke-linecap="round"/>
    <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="14" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="3"/>
    <rect x="7" y="7" width="${w - 14}" height="${h - 14}" rx="10" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="2" stroke-dasharray="10 7"/>
  </svg>`;
}

export function createRenderer() {
  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const queueEl = $('queue');
  const slotsEl = $('slots');
  const hudLevelEl = $('hud-level');
  const hudMovesEl = $('hud-moves');
  const boardWrapEl = $('board-wrap');
  const queueCountEl = $('queue-count');

  let cell = 40;
  /** 车身相对格区的视觉缩放：留出车位线与相邻车的边界。 */
  const BUS_VISUAL_SCALE = 0.9;

  /* ---------- HUD ---------- */
  function renderHud(state, level) {
    hudLevelEl.textContent = `第 ${level.id} 关 · ${level.name} ▾`;
    hudMovesEl.textContent = `操作 ${state.moveCount}`;
  }

  /* ---------- 选关页 ---------- */
  function renderLevelSelect(summaries, currentIndex) {
    const grid = $('level-grid');
    $('levels-count').textContent = `共 ${summaries.length} 关`;
    grid.innerHTML = '';
    for (const s of summaries) {
      const btn = document.createElement('button');
      btn.className = 'level-cell' + (s.index === currentIndex ? ' current' : '');
      btn.dataset.levelIndex = String(s.index);
      btn.title = `第 ${s.id} 关 · ${s.name}`;
      const stars = s.difficulty ? '★'.repeat(s.difficulty) : '';
      btn.innerHTML =
        `<span class="level-no">${s.id}</span>` +
        `<span class="level-name">${s.name}</span>` +
        `<span class="level-stars">${stars}</span>`;
      grid.appendChild(btn);
    }
  }

  /* ---------- 停车场 ---------- */
  function renderBoard(state) {
    // 预留 #board 的外圈描边/阴影（CSS 中约 9px），避免手机窄屏被裁切。
    // 不设固定最小 cell：空间不足时优先缩小棋盘，保证整块场地可见。
    const BOARD_GUTTER = 10;
    const availW = boardWrapEl.clientWidth - BOARD_GUTTER * 2;
    const availH = boardWrapEl.clientHeight - BOARD_GUTTER * 2;
    if (availW > 0 && availH > 0) {
      cell = Math.max(6, Math.floor(Math.min(availW / state.grid.cols, availH / state.grid.rows)));
    }
    const w = cell * state.grid.cols;
    const h = cell * state.grid.rows;
    boardEl.style.width = `${w}px`;
    boardEl.style.height = `${h}px`;
    boardEl.style.setProperty('--cell', `${cell}px`);

    boardEl.innerHTML = lotBackgroundSvg(state.grid.cols, state.grid.rows, cell);
    for (let r = 0; r < state.grid.rows; r++) {
      for (let c = 0; c < state.grid.cols; c++) {
        const g = document.createElement('div');
        g.className = 'cell';
        g.style.left = `${c * cell}px`;
        g.style.top = `${r * cell}px`;
        g.style.width = `${cell}px`;
        g.style.height = `${cell}px`;
        boardEl.appendChild(g);
      }
    }
    // 只读查询：驶出路径畅通的车加柔和高亮（不显示任何计数）
    const occ = buildOccupancy(state);
    for (const bus of Object.values(state.buses)) {
      if (bus.status !== 'board' && bus.status !== 'waiting') continue;
      const el = makeBoardBus(bus);
      if (bus.status === 'waiting') {
        el.classList.add('is-waiting');
        el.title = '已在等待队列，接客位空出后会自动驶入';
      } else if (pathIsClear(bus, state, occ)) {
        el.classList.add('can-exit');
      }
      boardEl.appendChild(el);
    }
  }

  function makeBoardBus(bus) {
    const horizontal = bus.dir === 'left' || bus.dir === 'right';
    const zoneW = (horizontal ? bus.len : 1) * cell;
    const zoneH = (horizontal ? 1 : bus.len) * cell;
    const busW = zoneW * BUS_VISUAL_SCALE;
    const busH = zoneH * BUS_VISUAL_SCALE;
    // 横向 SVG 的原始画布：长 × 宽；竖直车旋转后与格区重合
    const svgW = horizontal ? busW : busH;
    const svgH = horizontal ? busH : busW;
    const el = document.createElement('div');
    el.className = `bus c-${bus.color} dir-${bus.dir}`;
    el.dataset.busId = bus.id;
    el.style.left = `${bus.x * cell}px`;
    el.style.top = `${bus.y * cell}px`;
    el.style.width = `${zoneW}px`;
    el.style.height = `${zoneH}px`;
    const svgStyle =
      `width:${svgW}px;height:${svgH}px;left:${(busW - svgW) / 2}px;top:${(busH - svgH) / 2}px`;
    el.innerHTML = `
      <div class="bus-inner"
           style="width:${busW}px;height:${busH}px;left:${(zoneW - busW) / 2}px;top:${(zoneH - busH) / 2}px">
        ${busSvgMarkup(bus.len, { style: svgStyle })}
      </div>`;
    el.title = '点击巴士，沿箭头方向驶出';
    return el;
  }

  /* ---------- 候车队列（数据窗口 + FLIP 补位） ----------
     只把队首附近有限数量的猫放进 DOM；后方猫咪留在 state.queue 中，
     当前面的猫上车后自动补位。这样既不会一次铺满屏幕，也能保留
     完整队列顺序。 */
  function visibleQueueCount() {
    const w = queueEl.clientWidth || 360;
    // 猫头宽度由 CSS 的 --queue-cat-w 控制（手机更紧凑），
    // 先读取实际值再计算能放几只，避免窄屏溢出或桌面显示过少。
    const styles = getComputedStyle(queueEl);
    const itemW = parseFloat(styles.getPropertyValue('--queue-cat-w')) || 40;
    const gap = parseFloat(styles.columnGap || styles.gap) || 2;
    // 预留：左侧“先上”标签 + 右侧 “+N 只候车” 徽标 + 内边距。
    return Math.max(3, Math.min(9, Math.floor((w - 118) / (itemW + gap))));
  }

  function renderQueue(state) {
    const prevRects = new Map();
    queueEl.querySelectorAll('.passenger').forEach((el) => {
      prevRects.set(el.dataset.passengerId, el.getBoundingClientRect());
    });
    const visible = Math.min(state.queue.length, visibleQueueCount());
    const hidden = Math.max(0, state.queue.length - visible);

    queueEl.innerHTML = '';
    if (state.queue.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'queue-empty';
      empty.textContent = '🐾 猫咪们全都上车啦';
      queueEl.appendChild(empty);
      if (queueCountEl) queueCountEl.textContent = '已全部上车';
      return;
    }

    for (let i = 0; i < visible; i++) {
      const p = state.queue[i];
      const el = document.createElement('div');
      el.className = `passenger c-${p.color}${i === 0 ? ' head' : ''}`;
      el.dataset.passengerId = p.id;
      el.dataset.color = p.color;
      if (i === 0) el.title = '队首猫咪：下一个上车';
      el.innerHTML = catSvgMarkup();
      queueEl.appendChild(el);
    }

    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'queue-more';
      more.innerHTML = `<b>+${hidden}</b><span>只候车</span>`;
      more.title = `还有 ${hidden} 只猫咪在后方排队`;
      queueEl.appendChild(more);
    }
    if (queueCountEl) {
      queueCountEl.textContent = `剩余 ${state.queue.length} 只 · 队首 ${COLOR_CN[state.queue[0].color] || ''}`;
    }

    // FLIP：让老猫平滑左移，新补位的猫从右侧滑入
    queueEl.querySelectorAll('.passenger').forEach((el) => {
      const old = prevRects.get(el.dataset.passengerId);
      if (!old) {
        el.classList.add('q-enter');
        return;
      }
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        if (typeof el.animate === 'function') {
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: 280, easing: 'cubic-bezier(.2,.85,.3,1)' }
          );
        }
      }
    });
  }

  const COLOR_CN = {
    red: '红色', blue: '蓝色', green: '绿色', purple: '紫色',
    cyan: '青色', orange: '橙色', yellow: '黄色',
  };

  /* ---------- 接客位 ---------- */
  function renderSlots(state, opts = {}) {
    const inTransit = opts.inTransit instanceof Set ? opts.inTransit : null;
    // 4 个基础位 + 最多 2 个临时位：用 CSS Grid 按实际数量等分，
    // 手机上 5–6 个位也不会挤出屏幕。
    slotsEl.style.setProperty('--slot-count', String(state.slots.length));
    slotsEl.classList.toggle('slots-many', state.slots.length > 4);
    const waitingEl = $('waiting-count');
    if (waitingEl) {
      const n = state.waiting?.length ?? 0;
      waitingEl.textContent = n > 0 ? `等待 ${n} 辆` : '';
    }
    const bonusEl = $('slot-bonus');
    if (bonusEl) {
      const extra = state.slots.filter((s) => s.extra).length;
      bonusEl.textContent = extra > 0 ? `临时 +${extra}` : '';
    }
    slotsEl.innerHTML = '';
    state.slots.forEach((slot) => {
      const s = document.createElement('div');
      s.className = 'slot' + (slot.extra ? ' slot-extra' : '');
      s.dataset.slot = String(slot.index);
      if (slot.extra) {
        s.innerHTML = '<span class="slot-extra-badge">临时</span>';
      }
      if (slot.busId == null) {
        s.innerHTML += `<div class="slot-empty"><span class="slot-paw">${slot.extra ? '🅿️' : '🐾'}</span><span>${slot.extra ? '临时空位' : '空位'}</span></div>`;
      } else if (inTransit?.has(slot.busId)) {
        // 逻辑上已预留接客位，但驶出动画还没播完：不提前显示车辆/载客数。
        s.innerHTML += `<div class="slot-empty slot-incoming"><span class="slot-paw">🚌</span><span>驶入中</span></div>`;
      } else {
        const bus = state.buses[slot.busId];
        // 接客位内统一朝右：车辆已转入发车位，载客进度固定在车位顶部
        s.innerHTML += `
          <div class="slot-load" aria-label="载客 ${bus.passengers}/${bus.capacity}">
            <span class="slot-load-paw">🐾</span><b>${bus.passengers}</b><i>/</i><span>${bus.capacity}</span>
          </div>
          <div class="slot-bus c-${bus.color} dir-right${opts.pop === bus.id ? ' pop-in' : ''}"
               data-slot-bus="${bus.id}">
            ${busSvgMarkup(bus.len, { style: 'width:100%;height:100%;left:0;top:0' })}
          </div>`;
      }
      slotsEl.appendChild(s);
    });
  }

  /* ---------- 驶出路径预览（只读，绝不修改 state） ---------- */
  function clearPathPreview() {
    boardEl.querySelectorAll('.path-hint').forEach((e) => e.remove());
  }

  function showPathPreview(state, busId) {
    clearPathPreview();
    const bus = state?.buses[busId];
    if (!bus || bus.status !== 'board' || state.status !== 'playing') return;
    const occ = buildOccupancy(state);
    const inset = Math.max(3, Math.round(cell * 0.1));
    for (const c of exitPathOfBus(bus, state.grid)) {
      const hit = occ.get(`${c.x},${c.y}`);
      const d = document.createElement('div');
      d.className = `path-hint${hit ? ' blocked' : ''}`;
      d.style.left = `${c.x * cell + inset}px`;
      d.style.top = `${c.y * cell + inset}px`;
      d.style.width = `${cell - inset * 2}px`;
      d.style.height = `${cell - inset * 2}px`;
      boardEl.appendChild(d);
      if (hit) break;
    }
  }

  /* ---------- 动画辅助 ---------- */
  function getBoardBus(busId) {
    return boardEl.querySelector(`.bus[data-bus-id="${busId}"]`);
  }

  /** 点击提交后立即给出「处理中」视觉，重复点击仍由状态层拦截。 */
  function markBusProcessing(busId) {
    const el = getBoardBus(busId);
    if (el) {
      el.classList.remove('is-waiting');
      el.classList.add('is-queued');
    }
  }

  /** 满位排队：保留车辆在棋盘上的视觉，并给出等待态样式。 */
  function markBusWaiting(busId) {
    const el = getBoardBus(busId);
    if (el) el.classList.add('is-waiting');
  }

  function getSlotBus(busId) {
    return slotsEl.querySelector(`.slot-bus[data-slot-bus="${busId}"]`);
  }

  function getQueueHead() {
    return queueEl.querySelector('.passenger');
  }

  function bumpSlotBus(busId) {
    const el = getSlotBus(busId);
    if (!el) return;
    el.classList.add('anim-bump');
    setTimeout(() => el.classList.remove('anim-bump'), 360);
  }

  /** 提示系统定位到具体车辆：短暂高亮，不改变任何游戏状态。 */
  function pulseBus(busId) {
    const target = getBoardBus(busId)?.querySelector('.bus-inner')
      || getSlotBus(busId);
    if (!target) return;
    target.classList.remove('hint-focus');
    void target.offsetWidth;
    target.classList.add('hint-focus');
    setTimeout(() => target.classList.remove('hint-focus'), 1600);
  }

  function renderAll(state, level) {
    renderHud(state, level);
    // 先渲染会改变纵向高度的队列/接客位，再计算棋盘 cell
    renderQueue(state);
    renderSlots(state);
    renderBoard(state);
  }

  return {
    renderAll,
    renderHud,
    renderLevelSelect,
    renderBoard,
    renderQueue,
    renderSlots,
    showPathPreview,
    clearPathPreview,
    getBoardBus,
    getSlotBus,
    getQueueHead,
    markBusProcessing,
    markBusWaiting,
    bumpSlotBus,
    pulseBus,
    boardEl,
    queueEl,
    slotsEl,
    getCellSize: () => cell,
  };
}