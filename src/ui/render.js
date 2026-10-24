/**
 * 渲染层：把 state 映射为 DOM。
 * - 幂等：可反复调用，结果一致（每次全量重建，棋盘规模小无性能问题）；
 * - 只读：绝不修改游戏状态（唯一新增的只读查询是 pathIsClear /
 *   buildOccupancy，用于给「可驶出」的巴士画提示箭头）；
 * - 与逻辑层仅通过 state（只读）与 data-* 属性交互。
 *
 * 视觉素材全部为内联 SVG（原创绘制，无外部图片依赖）：
 *  - 候车乘客：完整卡通人物（头/身体/四肢），衣服颜色即匹配色；
 *  - 停车场巴士：卡通公交（车头挡风玻璃/乘客窗/车门/车轮/车灯），
 *    朝向用 CSS 旋转表达，绘制比例与占用格严格一致（40px/格）。
 *
 * DOM 契约（controller.js 动画依赖，修改时必须保持）：
 *  - .bus（格区点击热区）/ .bus-inner（车身，闪烁反馈目标）
 *  - .passenger（含 .head 队首，飞行上车动画载体）
 *  - .slot-bus（含 data-slot-bus，发车/弹跳动画载体）
 */
import { buildOccupancy, pathIsClear, exitPathOfBus } from '../game/logic.js';

/* ================ SVG 素材（原创，无外部依赖） ================ */

/**
 * 卡通公交巴士 · 俯视图（默认朝右）。
 * 绘制比例与占格严格一致：viewBox 每格 40×40。
 * 俯视要素：
 *  - 车身轮廓（圆角矩形）+ 车顶中线浅色带；
 *  - 左右两侧各 2 个半露车轮（先画车轮再画车身，露出半圆）；
 *  - 车头：挡风玻璃横条 + 双前灯（黄）；车尾：双尾灯（红）；
 *  - 车顶座位进度点（capacity 个，已载为实心白）；
 *  - 车顶方向箭头（双层 chevron：深色描边底 + 白面），
 *    指向车头端 —— 朝向语义与 bus.dir 完全一致：
 *    箭头随车身整体旋转（.dir-* CSS 变换），与挡风玻璃、
 *    驶出动画共用同一变换，不存在映射错位。
 * 导出供开始页示例巴士复用（风格统一）。
 */
export function busSvgMarkup(len, opts = {}) {
  const W = 40 * len;
  const capacity = opts.capacity ?? len;
  const seatsFilled = opts.seatsFilled ?? 0;
  const style = opts.style || '';
  // 车顶座位进度点：车尾 -> 中部一列
  let seats = '';
  for (let i = 0; i < capacity; i++) {
    seats += `<circle class="bus-seat${i < seatsFilled ? ' filled' : ''}" cx="${11 + i * 11}" cy="20" r="2.5"/>`;
  }
  // 车顶方向箭头（chevron，指向车头/右）：深色衬底 + 白色箭头
  const cx = W / 2 + 2;
  const arrowD = `M${cx - 6} 14.6 L${cx + 4.5} 20 L${cx - 6} 25.4`;
  return `<svg class="bus-svg" viewBox="0 0 ${W} 40"${style ? ` style="${style}"` : ''} aria-hidden="true">
    <circle class="bus-wheel" cx="20" cy="8" r="4.2"/>
    <circle class="bus-wheel" cx="${W - 20}" cy="8" r="4.2"/>
    <circle class="bus-wheel" cx="20" cy="32" r="4.2"/>
    <circle class="bus-wheel" cx="${W - 20}" cy="32" r="4.2"/>
    <rect class="bus-body" x="4" y="9" width="${W - 8}" height="22" rx="5"/>
    <rect class="bus-topline" x="9" y="17.8" width="${W - 18}" height="4.4" rx="2.2"/>
    ${seats}
    <rect class="bus-windshield" x="${W - 13}" y="12" width="5.5" height="16" rx="2"/>
    <circle class="bus-lamp" cx="${W - 6.5}" cy="13" r="1.9"/>
    <circle class="bus-lamp" cx="${W - 6.5}" cy="27" r="1.9"/>
    <circle class="bus-taillight" cx="6.5" cy="13" r="1.7"/>
    <circle class="bus-taillight" cx="6.5" cy="27" r="1.7"/>
    <path class="bus-arrow-under" d="${arrowD}"/>
    <path class="bus-arrow" d="${arrowD}"/>
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

  let cell = 40;

  /**
   * 车辆视觉缩放：车身显示为格区的 82%（80%~85% 区间内）。
   * .bus 元素本身保持整格大小与位置 —— 点击热区、格点坐标、
   * 车与车之间的位置/遮挡关系完全不变，仅车身视觉缩小并居中。
   */
  const BUS_VISUAL_SCALE = 0.82;

  /**
   * 卡通候车乘客（完整人物：头、身体、双臂、双腿）。
   * 衣服颜色 = --pc（乘客匹配色），头/表情统一风格与比例。
   */
  function passengerSvgMarkup() {
    return `<svg class="pp-svg" viewBox="0 0 36 46" aria-hidden="true">
      <rect class="pp-leg" x="12.5" y="33.5" width="4.6" height="10.5" rx="2.3"/>
      <rect class="pp-leg" x="18.9" y="33.5" width="4.6" height="10.5" rx="2.3"/>
      <rect class="pp-arm" x="4.6" y="19.5" width="4.6" height="11.5" rx="2.3"/>
      <rect class="pp-arm" x="26.8" y="19.5" width="4.6" height="11.5" rx="2.3"/>
      <rect class="pp-body" x="8.5" y="17" width="19" height="19" rx="6.5"/>
      <circle class="pp-head" cx="18" cy="10" r="8"/>
      <path class="pp-hair" d="M10.6 9.4 a 7.4 7.4 0 0 1 14.8 0"/>
      <circle class="pp-eye" cx="15.2" cy="10.8" r="1.35"/>
      <circle class="pp-eye" cx="20.8" cy="10.8" r="1.35"/>
      <circle class="pp-blush" cx="12.7" cy="13.4" r="1.5"/>
      <circle class="pp-blush" cx="23.3" cy="13.4" r="1.5"/>
      <path class="pp-mouth" d="M16.3 14.1 q 1.7 1.6 3.4 0"/>
    </svg>`;
  }

  /* ---------- HUD ---------- */
  function renderHud(state, level) {
    hudLevelEl.textContent = `第 ${level.id} 关 · ${level.name} ▾`;
    hudMovesEl.textContent = `操作 ${state.moveCount}`;
  }

  /* ---------- 选关页 ----------
     渲染全部关卡格子（编号 + 名称 + 难度星级），当前关高亮；
     纯展示，点击跳转由 controller 处理。 */
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
    const availW = boardWrapEl.clientWidth - 4;
    const availH = boardWrapEl.clientHeight - 4;
    cell = Math.max(22, Math.floor(Math.min(availW / state.grid.cols, availH / state.grid.rows)));
    const w = cell * state.grid.cols;
    const h = cell * state.grid.rows;
    boardEl.style.width = `${w}px`;
    boardEl.style.height = `${h}px`;

    boardEl.innerHTML = '';
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
    // 只读查询：驶出路径畅通的车加「可驶出」提示（箭头）
    const occ = buildOccupancy(state);
    for (const bus of Object.values(state.buses)) {
      if (bus.status !== 'board') continue;
      const el = makeBoardBus(bus);
      if (pathIsClear(bus, state, occ)) el.classList.add('can-exit');
      boardEl.appendChild(el);
    }
  }

  function makeBoardBus(bus) {
    const horizontal = bus.dir === 'left' || bus.dir === 'right';
    // 格区：逻辑位置与点击热区（保持原始尺寸，避免点击错位）
    const zoneW = (horizontal ? bus.len : 1) * cell;
    const zoneH = (horizontal ? 1 : bus.len) * cell;
    // 车身（.bus-inner）：按 BUS_VISUAL_SCALE 缩小并在格区内居中
    const busW = zoneW * BUS_VISUAL_SCALE;
    const busH = zoneH * BUS_VISUAL_SCALE;
    // SVG 画布：横向绘制（车长×车宽）。水平车直接铺满车身；
    // 竖直车画布为「长×宽」，经 CSS 旋转 90° 后视觉与车身格区重合。
    const length = Math.max(busW, busH);
    const width = Math.min(busW, busH);
    const svgW = horizontal ? busW : length;
    const svgH = horizontal ? busH : width;
    const svgLeft = (busW - svgW) / 2;
    const svgTop = (busH - svgH) / 2;
    const el = document.createElement('div');
    el.className = `bus c-${bus.color} dir-${bus.dir}`;
    el.dataset.busId = bus.id;
    el.style.left = `${bus.x * cell}px`;
    el.style.top = `${bus.y * cell}px`;
    el.style.width = `${zoneW}px`;
    el.style.height = `${zoneH}px`;
    // svg 画布尺寸/位置内联（比例与 viewBox 严格一致，meet 精确铺满）
    const svgStyle = `width:${svgW}px;height:${svgH}px;left:${svgLeft}px;top:${svgTop}px`;
    el.innerHTML = `
      <div class="bus-inner"
           style="width:${busW}px;height:${busH}px;left:${(zoneW - busW) / 2}px;top:${(zoneH - busH) / 2}px">
        ${busSvgMarkup(bus.len, { style: svgStyle, capacity: bus.capacity, seatsFilled: bus.passengers })}
        <div class="bus-cap">${bus.passengers}/${bus.capacity}</div>
      </div>`;
    el.title = '点击驶出停车场';
    return el;
  }

  /* ---------- 候车队列 ---------- */
  function renderQueue(state) {
    queueEl.innerHTML = '';
    if (state.queue.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'queue-empty';
      empty.textContent = '🎉 乘客已全部上车';
      queueEl.appendChild(empty);
      return;
    }
    state.queue.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = `passenger c-${p.color}${i === 0 ? ' head' : ''}`;
      if (i === 0) el.title = '队首：下一个上车';
      el.innerHTML = passengerSvgMarkup();
      queueEl.appendChild(el);
    });
  }

  /* ---------- 接客位 ---------- */
  function renderSlots(state, opts = {}) {
    slotsEl.innerHTML = '';
    state.slots.forEach((slot) => {
      const s = document.createElement('div');
      s.className = 'slot';
      s.dataset.slot = String(slot.index);
      if (slot.busId == null) {
        s.innerHTML = `<div class="slot-empty">空位</div>`;
      } else {
        const bus = state.buses[slot.busId];
        s.innerHTML = `
          <div class="slot-bus c-${bus.color}${opts.pop === bus.id ? ' pop-in' : ''}"
               data-slot-bus="${bus.id}">
            ${busSvgMarkup(bus.len, { capacity: bus.capacity, seatsFilled: bus.passengers })}
            <div class="bus-cap">${bus.passengers}/${bus.capacity}</div>
          </div>`;
      }
      slotsEl.appendChild(s);
    });
  }

  /* ---------- 驶出路径预览（只读，绝不修改 state） ----------
     hover 某辆棋盘巴士时，把「车头到棋盘边缘」的路径格显示出来：
     畅通格为绿色，首个阻挡格为红色（含阻挡车所在格，之后的格无意义不显示）。
     预览元素随 renderBoard 的全量重建自动清除。 */
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
      if (hit) break; // 阻挡点之后的路径无意义，只标到首个障碍
    }
  }

  /* ---------- 动画辅助 ---------- */
  function getBoardBus(busId) {
    return boardEl.querySelector(`.bus[data-bus-id="${busId}"]`);
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
    setTimeout(() => el.classList.remove('anim-bump'), 320);
  }

  function renderAll(state, level) {
    renderHud(state, level);
    // 先渲染决定纵向布局的内容区（队列/接客位），再计算棋盘：
    // 棋盘 cell 依赖 board-wrap 的剩余高度，若顺序颠倒，
    // 换关时队列高度变化会导致棋盘按旧布局计算而溢出。
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
    bumpSlotBus,
    boardEl,
    queueEl,
    slotsEl,
    getCellSize: () => cell,
  };
}
