/**
 * 渲染层：把 state 映射为 DOM。
 * ------------------------------------------------------------
 * 视觉素材全部为内联 SVG（原创、无外部资源、断网可用）：
 *  - 巴士：上一版统一的 2.5D 玩具公交俯视图（车身/车窗/车轮/车顶设备/
 *    高光/阴影），车顶为「深色描边 + 粗白箭头」的驶出方向标识；
 *    横向车直接绘制，纵向车旋转 SVG 自身，不改变实际占格数据；
 *  - 猫咪：圆润的猫咪头（耳朵、双眼、鼻子、嘴、腮红、胡须），
 *    只用轻量浮动/眨眼/补位/弹跳缩小动画，不做身体或骨骼动画；
 *  - 停车场：深蓝灰地面 + 圆角格位微光，车辆密集但边界清楚。
 *
 * DOM 契约（controller.js 动画依赖，修改时必须保持）：
 *  - .bus（格区点击热区）/ .bus-inner（车身，闪烁反馈目标）
 *  - .passenger（含 .head 队首，走路/上车动画载体）
 *  - .slot-bus（含 data-slot-bus，发车/弹跳动画载体）
 *  - .slot-load（只出现在接客位上的载客进度）
 */
import { buildOccupancy, pathIsClear, exitPathOfBus } from '../game/logic.js';
import { getClearedMax, getProgressSummary } from './progress.js';

/* ================ SVG 素材（原创，无外部依赖） ================ */

/** 猫咪头部件（队列猫 / 上车猫 / 巴士头像徽章共用）：耳朵、脸、眼睛与简单表情。 */
function catHeadInner() {
  return `
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
      <path class="cat-whisker" d="M11 36 L1.5 33.5 M11 40 L1.5 41 M53 36 L62.5 33.5 M53 40 L62.5 41"/>`;
}

/**
 * 2.5D 玩具公交 · 默认朝右（上一版游戏内车辆素材）。
 * viewBox 比例严格为「车长 : 车宽 = len : 1」，与占用格一致。
 * 统一透视：车头在右，车尾在左；同一套高光/阴影/材质用于所有车辆。
 * 纵向车辆由 CSS 旋转 SVG 自身（.dir-up/.dir-down），
 * 不改变车辆实际长度、宽度、占格数量和方向数据。
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
    <g class="cat-head">${catHeadInner()}</g>
  </svg>`;
}

/**
 * 首页主视觉：侧视黄色「猫咪巴士」（原创内联 SVG，无外部资源）。
 * 车身/车窗/车轮/顶牌全部矢量绘制；车窗里的猫咪不在此函数内，
 * 由 main.js 复用 catSvgMarkup() 以 HTML 绝对定位叠加（.hero-window-cat），
 * 坐标与下方三块车窗玻璃一一对应（viewBox 640x340）。
 */
export function heroBusSvgMarkup() {
  const windows = [64, 196, 328].map((x) => `
    <g class="hero-win">
      <rect x="${x}" y="92" width="118" height="98" rx="20" fill="#fff6dd" stroke="#e9c98d" stroke-width="2.5"/>
      <rect x="${x + 9}" y="101" width="100" height="80" rx="13" fill="url(#hero-glass)"/>
      <path d="M ${x + 20} 168 L ${x + 48} 112" stroke="rgba(255,255,255,.7)" stroke-width="7" stroke-linecap="round"/>
      <path d="M ${x + 36} 170 L ${x + 56} 130" stroke="rgba(255,255,255,.45)" stroke-width="4" stroke-linecap="round"/>
    </g>`).join('');

  return `<svg class="hero-bus-svg" viewBox="0 0 640 340" aria-hidden="true">
    <defs>
      <linearGradient id="hero-body" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe477"/>
        <stop offset=".55" stop-color="#ffc93f"/>
        <stop offset="1" stop-color="#f7b026"/>
      </linearGradient>
      <linearGradient id="hero-glass" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e6f7ff"/>
        <stop offset="1" stop-color="#b5e0f8"/>
      </linearGradient>
      <clipPath id="hero-body-clip">
        <rect x="28" y="48" width="584" height="224" rx="48"/>
      </clipPath>
    </defs>

    <!-- 落地阴影 -->
    <ellipse cx="320" cy="317" rx="266" ry="13" fill="rgba(46,94,40,.18)"/>

    <!-- 车轮（先画，车身压住上半） -->
    <g class="hero-wheels">
      <circle cx="155" cy="272" r="41" fill="#333a42" stroke="#1f242a" stroke-width="3"/>
      <circle cx="155" cy="272" r="17" fill="#e3e8ec" stroke="#a5aeb6" stroke-width="2"/>
      <circle cx="155" cy="272" r="5.5" fill="#a5aeb6"/>
      <circle cx="485" cy="272" r="41" fill="#333a42" stroke="#1f242a" stroke-width="3"/>
      <circle cx="485" cy="272" r="17" fill="#e3e8ec" stroke="#a5aeb6" stroke-width="2"/>
      <circle cx="485" cy="272" r="5.5" fill="#a5aeb6"/>
    </g>

    <!-- 车身主体 -->
    <rect x="28" y="48" width="584" height="224" rx="48" fill="url(#hero-body)" stroke="#e8952a" stroke-width="3.5"/>
    <g clip-path="url(#hero-body-clip)">
      <rect x="28" y="216" width="584" height="56" fill="#f2a52c"/>
      <rect x="28" y="204" width="584" height="14" fill="#fff3d2" opacity=".92"/>
      <path d="M 76 60 H 560" stroke="rgba(255,255,255,.5)" stroke-width="7" stroke-linecap="round"/>
      <!-- 裙边猫爪印装饰 -->
      <g fill="#e8952a" opacity=".5">
        <ellipse cx="320" cy="248" rx="13" ry="10"/>
        <circle cx="305" cy="233" r="5"/>
        <circle cx="315" cy="228" r="5"/>
        <circle cx="325" cy="228" r="5"/>
        <circle cx="335" cy="233" r="5"/>
      </g>
    </g>

    <!-- 车顶牌 -->
    <rect x="340" y="14" width="192" height="44" rx="16" fill="#fff8e8" stroke="#eecf95" stroke-width="2.5"/>
    <text x="436" y="44" text-anchor="middle" font-size="25" font-weight="800" letter-spacing="3"
          fill="#f08a2a" font-family="'PingFang SC', system-ui, sans-serif">CAT BUS</text>

    <!-- 侧窗 ×3（猫咪由 HTML 叠加在玻璃上） -->
    ${windows}

    <!-- 挡风玻璃（车头朝右） -->
    <g class="hero-windshield">
      <rect x="478" y="84" width="120" height="118" rx="24" fill="#fff6dd" stroke="#e9c98d" stroke-width="2.5"/>
      <rect x="487" y="93" width="102" height="100" rx="16" fill="url(#hero-glass)"/>
      <path d="M 502 176 L 540 106" stroke="rgba(255,255,255,.75)" stroke-width="8" stroke-linecap="round"/>
      <path d="M 524 180 L 552 128" stroke="rgba(255,255,255,.45)" stroke-width="4.5" stroke-linecap="round"/>
    </g>

    <!-- 前灯、尾灯 -->
    <circle cx="590" cy="232" r="18" fill="#fff6c9" opacity=".28"/>
    <circle cx="590" cy="232" r="12" fill="#fff6c9" stroke="#e0a63c" stroke-width="2.5"/>
    <rect x="38" y="200" width="13" height="26" rx="6.5" fill="#ff8f7e" stroke="#e0654f" stroke-width="2"/>
  </svg>`;
}

/** 停车场地面：深蓝灰渐变 + 顶部微光 + 内圈细描边（格位微光由 .cell 提供）。 */
function lotBackgroundSvg(cols, rows, cell) {
  const w = cols * cell;
  const h = rows * cell;
  return `<svg class="lot-bg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="lot-asphalt" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#46566c"/>
        <stop offset="1" stop-color="#38475b"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#lot-asphalt)"/>
    <rect width="${w}" height="${h * 0.42}" fill="rgba(255,255,255,.03)"/>
    <rect x="3" y="3" width="${w - 6}" height="${h - 6}" rx="14" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2"/>
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
  /** 车身相对格区的视觉缩放：尽量放大车辆，同时留出车位线边界。 */
  const BUS_VISUAL_SCALE = 0.95;
  /** 最近一次棋盘布局的快照，用于避免上车/结算期间重复改尺寸。 */
  let boardLayout = { cols: 0, rows: 0, width: 0, height: 0 };

  /* ---------- HUD ---------- */
  function renderHud(state, level) {
    hudLevelEl.textContent = `第 ${level.id} 关 · ${level.name} ▾`;
    hudMovesEl.textContent = `操作 ${state.moveCount}`;
  }

  /* ---------- 选关页 ----------
     通关状态来自 progress.js 存档：
     - 50 关全部开放，任意关卡均可点击进入，不再渲染锁定状态；
     - 已通关关卡带 ✓ 标记；当前进行中的关卡高亮描边；
     - 顶部计数展示当前通关进度。 */
  function renderLevelSelect(summaries, currentIndex) {
    const grid = $('level-grid');
    const prog = getProgressSummary();
    $('levels-count').textContent = `已通关 ${prog.cleared} / ${prog.total} 关`;
    grid.innerHTML = '';
    for (const s of summaries) {
      const cleared = s.index <= getClearedMax();
      const btn = document.createElement('button');
      btn.className = 'level-cell'
        + (s.index === currentIndex ? ' current' : '')
        + (cleared ? ' cleared' : '');
      btn.dataset.levelIndex = String(s.index);
      btn.title = `第 ${s.id} 关 · ${s.name}${cleared ? '（已通关）' : ''}`;
      const stars = s.difficulty ? '★'.repeat(s.difficulty) : '';
      btn.innerHTML =
        `<span class="level-no">${s.id}</span>` +
        `<span class="level-name">${s.name}</span>` +
        `<span class="level-stars">${cleared ? '<b class="level-done">✓ 已通关</b>' : stars}</span>`;
      grid.appendChild(btn);
    }
  }

  /* ---------- 首页内嵌选关面板 ----------
     与全屏选关页读取同一份 progress.js 存档；区别是：
     - .selected 表示玩家在首页刚刚点选的关卡（开始游戏进入它）；
     - .current 表示真实进度所在关卡（关闭选关功能时的默认起点）；
     - 50 关全部开放，点击任意关卡直接进入。 */
  function renderHomeLevelSelect(summaries, selectedIndex, progressIndex) {
    const grid = $('home-level-grid');
    if (!grid) return;
    const prog = getProgressSummary();
    const countEl = $('home-picker-count');
    if (countEl) countEl.textContent = `已通关 ${prog.cleared}/${prog.total}`;
    grid.innerHTML = '';
    for (const s of summaries) {
      const cleared = s.index <= getClearedMax();
      const btn = document.createElement('button');
      btn.className = 'level-cell'
        + (s.index === progressIndex ? ' current' : '')
        + (s.index === selectedIndex ? ' selected' : '')
        + (cleared ? ' cleared' : '');
      btn.dataset.levelIndex = String(s.index);
      btn.title = `第 ${s.id} 关 · ${s.name}${s.index === selectedIndex ? '（已选择）' : ''}${cleared ? '（已通关）' : ''}`;
      const stars = s.difficulty ? '★'.repeat(s.difficulty) : '';
      btn.innerHTML =
        `<span class="level-no">${s.id}</span>` +
        `<span class="level-name">${s.name}</span>` +
        `<span class="level-stars">${
          s.index === selectedIndex
            ? '<b class="level-picked">✓ 已选</b>'
            : cleared ? '<b class="level-done">✓ 已通关</b>' : stars
        }</span>`;
      grid.appendChild(btn);
    }
  }

  /* ---------- 停车场 ---------- */
  function renderBoard(state) {
    // 预留 #board 的外圈描边/阴影，避免手机窄屏被裁切。
    // 只在「网格或可用空间真的变化」时重算 cell，保证上车/结算期间
    // 棋盘容器的宽高、位置和坐标基准完全不变。
    const wrapStyle = getComputedStyle(boardWrapEl);
    const padX = (parseFloat(wrapStyle.paddingLeft) || 0) + (parseFloat(wrapStyle.paddingRight) || 0);
    const padY = (parseFloat(wrapStyle.paddingTop) || 0) + (parseFloat(wrapStyle.paddingBottom) || 0);
    const availW = Math.max(0, boardWrapEl.clientWidth - padX);
    const availH = Math.max(0, boardWrapEl.clientHeight - padY);
    const sizeChanged = Math.abs(availW - boardLayout.width) > 1
      || Math.abs(availH - boardLayout.height) > 1;
    const gridChanged = state.grid.cols !== boardLayout.cols
      || state.grid.rows !== boardLayout.rows;
    if ((gridChanged || sizeChanged) && availW > 0 && availH > 0) {
      cell = Math.max(6, Math.floor(Math.min(availW / state.grid.cols, availH / state.grid.rows)));
      boardLayout = {
        cols: state.grid.cols,
        rows: state.grid.rows,
        width: availW,
        height: availH,
      };
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
    // 上一版素材默认朝右：纵向车辆只旋转 SVG 自身，
    // 外层 .bus 热区仍严格等于实际占格，不改变移动逻辑。
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

  /* ---------- 候车队列（完整排列 + 横向滚动） ----------
     按 state.queue 的真实顺序为每只猫创建节点，第一排尽量排满；
     超出容器宽度时由 CSS 横向滚动查看，不再用「+N 只候车」气泡
     代替大部分猫咪。队列只会在队首消费，因此用增量同步避免每次
     上车都重建上百个节点。 */
  function passengerEl(p, isHead) {
    const el = document.createElement('div');
    el.className = `passenger c-${p.color}${isHead ? ' head' : ''}`;
    el.dataset.passengerId = p.id;
    el.dataset.color = p.color;
    if (isHead) el.title = '队首猫咪：下一个上车';
    el.innerHTML = catSvgMarkup();
    return el;
  }

  function syncQueueHead() {
    let first = true;
    queueEl.querySelectorAll('.passenger').forEach((el) => {
      el.classList.toggle('head', first);
      if (first) el.title = '队首猫咪：下一个上车';
      else el.removeAttribute('title');
      first = false;
    });
  }

  function renderQueue(state) {
    if (state.queue.length === 0) {
      queueEl.innerHTML = '<div class="queue-empty">🐾 猫咪们全都上车啦</div>';
      if (queueCountEl) queueCountEl.textContent = '已全部上车';
      return;
    }

    // 清除「已全部上车」等占位节点；正常队列里不应再有 +N 气泡。
    queueEl.querySelectorAll('.queue-empty, .queue-more').forEach((el) => el.remove());

    const ids = state.queue.map((p) => p.id);
    const idSet = new Set(ids);
    let rebuild = false;

    // 淘汰已上车的节点（通常只是队首这一只）。
    queueEl.querySelectorAll('.passenger').forEach((el) => {
      if (!idSet.has(el.dataset.passengerId)) el.remove();
    });

    const existing = Array.from(queueEl.querySelectorAll('.passenger'));
    if (existing.length > ids.length) {
      rebuild = true;
    } else {
      for (let i = 0; i < existing.length; i++) {
        if (existing[i].dataset.passengerId !== ids[i]) { rebuild = true; break; }
      }
    }

    if (rebuild) {
      // 队列被重新排序（例如救援）：按真实顺序整体重建。
      queueEl.querySelectorAll('.passenger').forEach((el) => el.remove());
      const frag = document.createDocumentFragment();
      for (let i = 0; i < state.queue.length; i++) {
        frag.appendChild(passengerEl(state.queue[i], i === 0));
      }
      queueEl.appendChild(frag);
    } else {
      // 正常上车：仅在尾部补齐（通常无需追加），不移动已有节点。
      for (let i = existing.length; i < ids.length; i++) {
        const isHead = i === 0;
        const el = passengerEl(state.queue[i], isHead);
        if (!isHead) el.classList.add('q-enter');
        queueEl.appendChild(el);
      }
      syncQueueHead();
    }

    if (queueCountEl) {
      const headName = COLOR_CN[state.queue[0].color] || '';
      queueCountEl.innerHTML =
        `剩余 <b class="qc-num">${state.queue.length}</b> 只 · 队首 <b class="qc-head">${headName}猫</b>`;
    }

    // 队首始终在最左侧：自动回到队首，避免多次上车后停在队列中段。
    queueEl.scrollLeft = 0;
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
    renderHomeLevelSelect,
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