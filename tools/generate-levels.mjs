/**
 * 关卡生成器（第 10–50 关）
 * ------------------------------------------------------------
 * 设计目标：
 *  1. 布局必须「错落」：不再把整行/整列铺满，而是用长度不一的车列、
 *     随机偏移、局部留白和横向/纵向混合，避免规则网格感；
 *  2. 每辆车的载客容量独立配置为 2/4/6，且同一关内混用；
 *  3. 颜色与猫咪队列必须和「车辆移除拓扑序」协同生成，保证有解。
 *
 * 生成流程：
 *  1. 选 2–4 条纵向车列 + 若干条横向车道；每条车道只占一段随机区间，
 *     车辆之间可以留 1 格空隙，因此车列不会从棋盘一边贯穿到另一边；
 *  2. 横向车辆只放在纵向车列之间的空档里，纵向车辆只放在自己的车列里；
 *     这样「先清纵向、再清横向」天然构成合法移除顺序；
 *  3. 按移除顺序切 2–3 辆一组并上色，队列按容量逐只生成；
 *  4. 第 10 关起相邻组按难度概率交换，制造「先停车、再接客」的周转；
 *  5. 用 logic.js 逐步回放参考解，校验开局可动、队首匹配、阻挡链、
 *     状态一致性；不通过就换布局/换队列重试。
 *
 * 场地随难度从 12×12 增长到 15×15，车辆数从 31 增长到 60，
 * 密度保持稳定但留出明显的通行/留白区域。
 *
 * 运行：node tools/generate-levels.mjs
 * 输出：src/game/generatedLevels.js
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  initializeLevel,
  moveBus,
  validateMove,
  settleAll,
  checkWin,
  SLOT_COUNT,
  BUS_CAPACITIES,
  lengthForCapacity,
  capacityForLength,
  validateStateInvariants,
} from '../src/game/logic.js';
import { validateLevelConfig } from '../src/game/levelRegistry.js';
import { analyzeLevel } from '../src/game/search.js';

const PALETTE = ['red', 'blue', 'green', 'purple', 'cyan', 'orange', 'yellow'];
const COLOR_CN = {
  red: '红色', blue: '蓝色', green: '绿色', purple: '紫色',
  cyan: '青色', orange: '橙色', yellow: '黄色',
};

const NAMES = [
  '猫潮初现', '双层车阵', '横竖交错', '猫步寻路', '拐角车海',
  '双列猫队', '车位告急', '三线并进', '猫爪迷宫', '车流回旋',
  '猫群涌入', '四道车墙', '窄位周转', '交叉猫道', '长龙候车',
  '接客位博弈', '车阵涟漪', '猫尾绕行', '双色夹击', '满位边缘',
  '猫潮高峰', '密林车阵', '七色猫队', '层层猫影', '车海穿针',
  '拥挤站台', '猫爪连环', '长队压境', '车位拉锯', '车阵风暴',
  '猫潮汹涌', '钢铁丛林', '极限周转', '猫群大迁徙', '车海迷宫',
  '接客位风暴', '猫爪千层', '终局车阵', '最后的空位', '猫潮之巅',
  '猫咪巴士大疏通',
];

/* ---------------- 确定性随机 ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, n) => Math.floor(rng() * n);

function shuffle(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 把 total 拆成 count 份，尽量均匀，返回打乱后的数组。 */
function distribute(rng, total, count, maxPerSlot = Infinity) {
  const base = Math.floor(total / count);
  let rest = total - base * count;
  const out = Array.from({ length: count }, () => Math.min(base, maxPerSlot));
  for (let i = 0; i < out.length && rest > 0; i++) {
    if (out[i] < maxPerSlot) { out[i] += 1; rest -= 1; }
  }
  // 极端情况下把剩余量继续摊到还有空间的槽位
  for (let i = 0; rest > 0 && i < out.length; i++) {
    const room = maxPerSlot - out[i];
    if (room > 0) {
      const take = Math.min(room, rest);
      out[i] += take;
      rest -= take;
    }
  }
  return shuffle(rng, out);
}

/* ---------------- 几何 ---------------- */

function gridSizeOf(id) {
  if (id <= 19) return 12;
  if (id <= 34) return 13;
  if (id <= 44) return 14;
  return 15;
}

function cellsOfBus(bus) {
  const out = [];
  if (bus.dir === 'left' || bus.dir === 'right') {
    for (let i = 0; i < bus.len; i++) out.push({ x: bus.x + i, y: bus.y });
  } else {
    for (let i = 0; i < bus.len; i++) out.push({ x: bus.x, y: bus.y + i });
  }
  return out;
}

function exitPathOfBus(bus, grid) {
  const out = [];
  if (bus.dir === 'right') for (let x = bus.x + bus.len; x < grid.cols; x++) out.push({ x, y: bus.y });
  else if (bus.dir === 'left') for (let x = 0; x < bus.x; x++) out.push({ x, y: bus.y });
  else if (bus.dir === 'down') for (let y = bus.y + bus.len; y < grid.rows; y++) out.push({ x: bus.x, y });
  else if (bus.dir === 'up') for (let y = 0; y < bus.y; y++) out.push({ x: bus.x, y });
  return out;
}

/** 从 1..cols-2 里挑 trunkCount 条纵向车列，彼此至少隔 2 格，尽量分散。 */
function pickTrunks(rng, cols, count) {
  const pool = Array.from({ length: Math.max(0, cols - 2) }, (_, i) => i + 1);
  const fallback = count === 2 ? [3, 8] : count === 3 ? [2, 6, 9] : [2, 5, 8, 11];
  if (pool.length < count) return fallback.slice(0, count);
  for (let tries = 0; tries < 200; tries++) {
    const picked = shuffle(rng, pool).slice(0, count).sort((a, b) => a - b);
    let ok = true;
    for (let i = 1; i < picked.length; i++) if (picked[i] - picked[i - 1] < 2) ok = false;
    if (ok) return picked;
  }
  return fallback.slice(0, count);
}

/** 一条车列的车辆长度 + 随机小空隙；返回 null 表示这一列放不下。 */
function laneSequence(rng, count, rows) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const parts = [];
    let total = 0;
    let ok = true;
    for (let i = 0; i < count; i++) {
      const reserve = (count - i - 1) * 2;
      let gap = i > 0 && rng() < 0.55 ? 1 : 0;
      let maxLen = Math.min(4, rows - total - reserve - gap);
      if (maxLen < 2 && gap) {
        gap = 0;
        maxLen = Math.min(4, rows - total - reserve);
      }
      if (maxLen < 2) { ok = false; break; }
      const options = [2, 3].filter((n) => n <= maxLen);
      if (maxLen >= 4 && rng() < 0.3) options.push(4);
      if (options.length === 0) { ok = false; break; }
      const len = options[randInt(rng, options.length)];
      parts.push({ len, gapBefore: gap });
      total += gap + len;
    }
    if (ok && total <= rows) return { parts, total };
  }
  return null;
}

/* ---------------- 布局搭建 ---------------- */

/**
 * 错落布局：纵向车列只占一部分行，横向车道只占一部分列，且随机留白。
 * order 的构造保证可解：先按车头方向清空每条纵向列，再逐行清空横向车道。
 */
function buildLayout({ grid, target, trunkCols, trunkDirs, seed }) {
  const rng = mulberry32(seed);
  const occ = new Set();
  const buses = [];
  const counters = new Map();
  const trunkSet = new Set(trunkCols);
  const key = (x, y) => `${x},${y}`;

  const nextId = (prefix) => {
    const n = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, n);
    return `${prefix}${n}`;
  };

  const canPlace = (bus) => {
    for (const c of cellsOfBus(bus)) {
      if (c.x < 0 || c.y < 0 || c.x >= grid.cols || c.y >= grid.rows) return false;
      if (occ.has(key(c.x, c.y))) return false;
    }
    return true;
  };

  const commit = (bus) => {
    for (const c of cellsOfBus(bus)) occ.add(key(c.x, c.y));
    buses.push(bus);
  };

  /* ---- 1. 纵向车列：只占随机的一段，车辆之间可能留 1 格空隙 ---- */
  const vTarget = Math.max(trunkCols.length * 2, Math.round(target * 0.22));
  const vCounts = distribute(rng, vTarget, trunkCols.length);
  const verticalByCol = trunkCols.map(() => []);

  for (let ti = 0; ti < trunkCols.length; ti++) {
    const col = trunkCols[ti];
    const dir = trunkDirs[ti];
    let placedCol = null;

    for (let attempt = 0; attempt < 140 && !placedCol; attempt++) {
      const seq = laneSequence(rng, vCounts[ti], grid.rows);
      if (!seq) continue;
      const yStart = randInt(rng, grid.rows - seq.total + 1);
      const temp = [];
      let y = yStart;
      let ok = true;
      for (const part of seq.parts) {
        y += part.gapBefore;
        const bus = { id: 'tmp', color: 'red', len: part.len, dir, x: col, y };
        if (!canPlace(bus)) { ok = false; break; }
        // 只检查与已占格子的冲突；同列临时车辆按顺序推进，不会互相重叠
        for (const c of cellsOfBus(bus)) {
          if (occ.has(key(c.x, c.y))) { ok = false; break; }
        }
        if (!ok) break;
        temp.push(bus);
        y += part.len;
      }
      if (ok && temp.length === vCounts[ti]) placedCol = temp;
    }

    if (!placedCol) return null;
    for (const bus of placedCol) {
      bus.id = nextId(`v${col}_`);
      commit(bus);
      verticalByCol[ti].push(bus);
    }
  }

  /* ---- 2. 横向车道：只填部分空档，前后随机偏移并留白 ---- */
  const hTarget = target - buses.length;
  if (hTarget < 0) return null;

  const maxPerRow = 4;
  const rowCount = Math.min(grid.rows, Math.max(3, Math.ceil(hTarget / 3.2)));
  if (rowCount * maxPerRow < hTarget) return null;
  const rowCounts = distribute(rng, hTarget, rowCount, maxPerRow);
  const allRows = shuffle(rng, Array.from({ length: grid.rows }, (_, i) => i));
  const activeRows = allRows.slice(0, rowCount);
  const rowDirs = new Map(activeRows.map((r) => [r, rng() < 0.5 ? 'right' : 'left']));
  const rowBuses = new Map(activeRows.map((r) => [r, []]));

  const tryPlaceRow = (row, dir, count) => {
    for (let attempt = 0; attempt < 90; attempt++) {
      const placed = [];
      let ok = true;
      for (let k = 0; k < count; k++) {
        let done = false;
        for (let t = 0; t < 260; t++) {
          const len = rng() < 0.68 ? 2 : (rng() < 0.85 ? 3 : 4);
          const x = randInt(rng, grid.cols - len + 1);
          const bus = { id: 'tmp', color: 'red', len, dir, x, y: row };
          const cells = cellsOfBus(bus);
          // 横向车辆绝不能占用纵向车列，保证「先清纵向」的拓扑序成立
          if (cells.some((c) => trunkSet.has(c.x))) continue;
          if (cells.some((c) => occ.has(key(c.x, c.y)))) continue;
          if (cells.some((c) => placed.some((p) => cellsOfBus(p).some((q) => q.x === c.x && q.y === c.y)))) continue;
          // 优先在车辆之间留出 1 格空隙，减少连成一整排的观感
          const wantGap = rng() < 0.55;
          if (wantGap && placed.some((p) => !(x + len < p.x || p.x + p.len < x))) continue;
          placed.push(bus);
          done = true;
          break;
        }
        if (!done) { ok = false; break; }
      }
      if (ok) return placed;
    }
    return null;
  };

  for (let ri = 0; ri < activeRows.length; ri++) {
    const row = activeRows[ri];
    const dir = rowDirs.get(row);
    const placed = tryPlaceRow(row, dir, rowCounts[ri]);
    if (!placed) return null;
    for (const bus of placed) {
      bus.id = nextId(`h${row}_`);
      commit(bus);
      rowBuses.get(row).push(bus);
    }
  }

  if (buses.length !== target) return null;

  /* ---- 3. 构造合法的移除顺序 ---- */
  const order = [];
  for (let ti = 0; ti < trunkCols.length; ti++) {
    const dir = trunkDirs[ti];
    const list = [...verticalByCol[ti]].sort((a, b) => (dir === 'up' ? a.y - b.y : b.y - a.y));
    order.push(...list);
  }
  for (const row of shuffle(rng, activeRows)) {
    const dir = rowDirs.get(row);
    const list = [...rowBuses.get(row)].sort((a, b) => (dir === 'right' ? b.x - a.x : a.x - b.x));
    order.push(...list);
  }

  return {
    buses,
    order,
    meta: {
      trunkCols,
      activeRows: [...activeRows].sort((a, b) => a - b),
      trunkDirs,
      rowDirs,
      grid: { ...grid },
    },
  };
}

const DIR_TRANSPOSE = { right: 'down', left: 'up', down: 'right', up: 'left' };
const OPPOSITE = { right: 'left', left: 'right', up: 'down', down: 'up' };

/** 对布局做转置/镜像，制造不同的车道结构与视觉方向。 */
function transformLayout(layout, transform, grid) {
  const transpose = transform.includes('transpose');
  const rot180 = transform.includes('rot180');
  const flipX = transform.includes('flipX') || rot180;
  const flipY = transform.includes('flipY') || rot180;
  for (const bus of layout.buses) {
    if (transpose) {
      const oldX = bus.x;
      bus.x = bus.y;
      bus.y = oldX;
      bus.dir = DIR_TRANSPOSE[bus.dir];
    }
    if (flipX) {
      const h = bus.dir === 'left' || bus.dir === 'right';
      bus.x = h ? grid.cols - bus.x - bus.len : grid.cols - 1 - bus.x;
      bus.dir = OPPOSITE[bus.dir];
    }
    if (flipY) {
      const v = bus.dir === 'up' || bus.dir === 'down';
      bus.y = v ? grid.rows - bus.y - bus.len : grid.rows - 1 - bus.y;
      bus.dir = OPPOSITE[bus.dir];
    }
  }
  const horizontal = layout.buses.filter((b) => b.dir === 'left' || b.dir === 'right');
  const vertical = layout.buses.filter((b) => b.dir === 'up' || b.dir === 'down');
  layout.meta = {
    ...layout.meta,
    horizontalCount: horizontal.length,
    verticalCount: vertical.length,
    horizontalRows: new Set(horizontal.map((b) => b.y)).size,
    verticalCols: new Set(vertical.map((b) => b.x)).size,
    transform,
  };
  return layout;
}

/** 布局质量指标：开局可动、单点扇出、最大直接阻挡、依赖链深度。 */
function layoutMetrics(buses, grid) {
  const occ = new Map();
  for (const bus of buses) {
    for (const c of cellsOfBus(bus)) occ.set(`${c.x},${c.y}`, bus.id);
  }

  const blockers = new Map(buses.map((b) => [b.id, new Set()]));
  const fan = new Map(buses.map((b) => [b.id, 0]));
  for (const bus of buses) {
    for (const c of exitPathOfBus(bus, grid)) {
      const id = occ.get(`${c.x},${c.y}`);
      if (id && id !== bus.id) blockers.get(bus.id).add(id);
    }
    for (const id of blockers.get(bus.id)) fan.set(id, (fan.get(id) ?? 0) + 1);
  }

  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const b of blockers.get(id)) d = Math.max(d, 1 + depth(b));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  let edges = 0;
  let chain = 0;
  for (const bus of buses) {
    edges += blockers.get(bus.id).size;
    chain = Math.max(chain, depth(bus.id));
  }

  const state = initializeLevel({ id: 0, grid, slots: SLOT_COUNT, buses, queue: [] });
  const legalIds = buses.filter((b) => validateMove(state, b.id).ok).map((b) => b.id);
  return {
    edges,
    chain,
    free: legalIds.length,
    legalIds,
    maxFan: Math.max(0, ...fan.values()),
    maxBlocked: Math.max(0, ...blockers.values().map((s) => s.size)),
  };
}

function occupancyKey(buses) {
  return buses
    .map((b) => `${b.dir}:${b.x},${b.y},${b.len}`)
    .sort()
    .join('|');
}

/** 是否出现被车辆占满的整行/整列（布局过于规则，需要重试）。 */
function hasFullLine(buses, grid) {
  const rows = new Map();
  const cols = new Map();
  for (const bus of buses) {
    for (const c of cellsOfBus(bus)) {
      rows.set(c.y, (rows.get(c.y) ?? 0) + 1);
      cols.set(c.x, (cols.get(c.x) ?? 0) + 1);
    }
  }
  return [...rows.values()].some((n) => n >= grid.cols)
    || [...cols.values()].some((n) => n >= grid.rows);
}

/**
 * 最长连续占格长度。即使整行没占满，连续 12–14 格的车墙仍会显得像规则网格，
 * 因此把「单条直线上的连续车辆长度」也作为布局质量约束。
 */
function longestOccupiedRun(buses, grid) {
  const map = new Set();
  for (const bus of buses) {
    for (const c of cellsOfBus(bus)) map.add(`${c.x},${c.y}`);
  }
  let longest = 0;
  for (let y = 0; y < grid.rows; y++) {
    let run = 0;
    for (let x = 0; x < grid.cols; x++) {
      run = map.has(`${x},${y}`) ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  for (let x = 0; x < grid.cols; x++) {
    let run = 0;
    for (let y = 0; y < grid.rows; y++) {
      run = map.has(`${x},${y}`) ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  return longest;
}

/* ---------------- 队列 / 容量 / 分组 ---------------- */

function chunkSizeOf(id) {
  if (id <= 19) return 2;                 // 入门：停 2 辆，留 2 个空位
  if (id <= 34) return id % 3 === 0 ? 3 : 2;
  return 3;                               // 后段：停 3 辆，留 1 个空位
}

function swapProbabilityOf(id) {
  if (id <= 14) return 0;                 // 先体验顺队列
  if (id <= 24) return 0.35;
  if (id <= 34) return 0.55;
  if (id <= 44) return 0.7;
  return 0.85;
}

/**
 * 容量由车身长度唯一映射：2格=2座、3格=4座、4格=6座。
 * 因此生成器必须保证每关同时出现 2/3/4 格车身，才能混用三种容量。
 */
function assignCapacityByLength(buses) {
  for (const bus of buses) {
    const capacity = capacityForLength(bus.len);
    if (!capacity) return false;
    bus.capacity = capacity;
    if (bus.len !== lengthForCapacity(capacity)) return false;
  }
  return BUS_CAPACITIES.every((cap) => buses.some((b) => b.capacity === cap));
}

/** 按大小切组，组内车辆在拓扑序中连续。 */
function buildChunks(order, size) {
  const chunks = [];
  for (let i = 0; i < order.length; i += size) chunks.push(order.slice(i, i + size));
  return chunks;
}

/**
 * 生成安全的组顺序：第一对永远保持「先到先接」，保证开局队首有合法车。
 * 之后按概率交换相邻组：玩家先停车队前一组（2–3 辆），再服务下一组。
 */
function buildChunkOrder(chunks, swapProbability, rng) {
  const out = [];
  for (let i = 0; i < chunks.length; i += 2) {
    const hasNext = i + 1 < chunks.length;
    if (!hasNext) { out.push(i); break; }
    const swap = i > 0 && rng() < swapProbability;
    if (swap) out.push(i + 1, i);
    else out.push(i, i + 1);
  }
  return out;
}

/** 用「游戏同一套规则」回放参考解，并逐步检查状态一致性。 */
function verifyReference(level) {
  const state = initializeLevel(level);
  settleAll(state);
  if (!validateStateInvariants(state).ok) return { ok: false, reason: 'initial invariants' };
  for (const id of level.solution.moves) {
    const check = validateMove(state, id);
    if (!check.ok) return { ok: false, reason: `${id}: ${check.reason}`, at: state.moveCount };
    const res = moveBus(state, id);
    if (!res.ok) return { ok: false, reason: `${id}: moveBus ${res.reason}`, at: state.moveCount };
    settleAll(state);
    if (!validateStateInvariants(state).ok) return { ok: false, reason: `${id}: invariants`, at: state.moveCount };
    if (state.status === 'lost') return { ok: false, reason: `${id}: deadlock`, at: state.moveCount };
  }
  const won = checkWin(state);
  return {
    ok: won,
    reason: won ? null : '回放结束但未通关',
    moves: state.moveCount,
    queueLeft: state.queue.length,
    slots: state.slots.filter((s) => s.busId != null).length,
  };
}

function headMatchCount(level) {
  const state = initializeLevel(level);
  const head = level.queue[0];
  return Object.values(state.buses)
    .filter((b) => b.status === 'board' && b.color === head && validateMove(state, b.id).ok)
    .length;
}

/** 目标车辆数：10 关 31 辆，50 关 60 辆，线性递增。 */
function targetCount(id) {
  if (id === 10) return 31;
  if (id === 50) return 60;
  return Math.round(31 + ((id - 10) * 29) / 40);
}

function difficultyOf(id) {
  if (id <= 19) return 2;
  if (id <= 29) return 3;
  if (id <= 39) return 4;
  return 5;
}

function colorCountOf(id) {
  if (id <= 19) return 5;
  if (id <= 34) return 6;
  return 7;
}

function transformFor(rng) {
  const options = ['none', 'transpose', 'flipX', 'flipY', 'rot180', 'transpose+flipX', 'transpose+flipY', 'transpose+rot180'];
  return options[randInt(rng, options.length)];
}

/**
 * 生成单关。
 * @param {number} id 关卡编号（决定尺寸/难度）
 * @param {Set<string>} usedKeys 已使用的布局签名（保证跨关不重复）
 * @param {{salt?: number, minOpeningSolutions?: number}} options
 *        salt 用于回归测试生成不同随机种子；默认 0 保持正式关卡确定性。
 */
export function buildLevel(id, usedKeys, options = {}) {
  const salt = options.salt ?? 0;
  const minOpeningSolutions = options.minOpeningSolutions ?? 2;
  const target = targetCount(id);
  const gridN = gridSizeOf(id);
  const grid = { cols: gridN, rows: gridN };
  const colorCount = colorCountOf(id);
  const chunkSize = chunkSizeOf(id);
  const swapProbability = swapProbabilityOf(id);
  const minLegal = Math.max(4, Math.ceil(target * 0.06));
  const maxLegal = Math.floor(target * 0.45);
  const minChain = id <= 19 ? 3 : 4;

  for (let attempt = 0; attempt < 2200; attempt++) {
    const rng = mulberry32(id * 10007 + attempt * 7919 + salt * 104729);
    const trunkCount = id <= 14 ? 2 + randInt(rng, 2) : 2 + randInt(rng, 3); // 2/3 或 2/3/4
    const trunkCols = pickTrunks(rng, gridN, trunkCount);
    const trunkDirs = trunkCols.map(() => (rng() < 0.5 ? 'up' : 'down'));
    const layout = buildLayout({
      grid,
      target,
      trunkCols,
      trunkDirs,
      seed: id * 911 + attempt * 131 + salt * 7919,
    });
    if (!layout) continue;

    transformLayout(layout, transformFor(rng), grid);
    if (hasFullLine(layout.buses, grid)) continue;
    if (longestOccupiedRun(layout.buses, grid) > Math.ceil(grid.cols * 0.7)) continue;
    const key = occupancyKey(layout.buses);
    if (usedKeys.has(key)) continue;

    const metrics = layoutMetrics(layout.buses, grid);
    if (metrics.free < minLegal || metrics.free > maxLegal) continue;
    if (metrics.maxFan > 10) continue;
    if (metrics.maxBlocked > 8) continue;
    if (metrics.chain < minChain) continue;

    // 为同一布局尝试多套色盘 / 组顺序；第一组永远先服务。
    for (let qtry = 0; qtry < 10; qtry++) {
      const qrng = mulberry32(id * 7777 + attempt * 313 + qtry * 101 + salt * 65537);
      const buses = layout.buses.map((b) => ({ ...b }));
      const byId = new Map(buses.map((b) => [b.id, b]));
      const order = layout.order.map((b) => byId.get(b.id));
      // 车身长度是容量的唯一来源；每关必须有 2/3/4 格三种车身。
      if (!assignCapacityByLength(buses)) continue;

      const palette = shuffle(qrng, PALETTE.slice(0, colorCount));
      const chunks = buildChunks(order, chunkSize);
      const chunkOrder = buildChunkOrder(chunks, swapProbability, qrng);

      // 中后段至少出现一次相邻组交换，避免所有关卡都是完全顺队列。
      if (id >= 20 && chunkOrder.every((ci, i) => ci === i)) continue;

      const chunkColors = chunks.map((_, i) => palette[i % palette.length]);
      chunks.forEach((chunk, ci) => {
        for (const bus of chunk) bus.color = chunkColors[ci];
      });

      const queue = [];
      for (const ci of chunkOrder) {
        for (const bus of chunks[ci]) {
          for (let j = 0; j < bus.capacity; j++) queue.push(chunkColors[ci]);
        }
      }

      const headColor = chunkColors[chunkOrder[0]];
      const swappedPairs = [];
      for (let i = 0; i < chunkOrder.length; i += 2) {
        if (chunkOrder[i] > chunkOrder[i + 1]) swappedPairs.push([chunkOrder[i + 1], chunkOrder[i]]);
      }
      const mode = layout.meta.horizontalCount >= layout.meta.verticalCount ? '横向车道为主' : '纵向通道为主';
      const level = {
        id,
        difficulty: difficultyOf(id),
        name: NAMES[id - 10],
        intent: '',
        hint: '',
        grid: { ...grid },
        slots: SLOT_COUNT,
        buses: buses.map(({ id: bid, color, len, dir, x, y, capacity }) => (
          { id: bid, color, len, dir, x, y, capacity }
        )),
        queue,
        solution: { moves: order.map((b) => b.id), par: order.length },
      };

      const v = validateLevelConfig(level);
      if (!v.ok) continue;
      const sim = verifyReference(level);
      if (!sim.ok) continue;
      const headMatch = headMatchCount(level);
      if (headMatch < 1) continue;

      // 解法多样性硬约束：至少 minOpeningSolutions 个不同开局决策
      // 都能用同一套真实规则找到完整通关路径。只统计「点击哪辆车」的
      // 真实决策序列，不把动画顺序或同色车换位当成新解法。
      const diversity = analyzeLevel(level, {
        branchNodes: 1200,
        criticalDepth: 0,
        maxSolutions: 3,
      });
      if (!diversity.solvable || diversity.solutionCount < minOpeningSolutions) continue;

      const capMix = BUS_CAPACITIES.map((c) => `${c}座×${buses.filter((b) => b.capacity === c).length}`).join(' / ');
      level.intent =
        `${level.buses.length} 辆车 · ${grid.cols}×${grid.rows} 场地 · ${SLOT_COUNT} 个接客位 · ${mode}`
        + `（横 ${layout.meta.horizontalCount} / 纵 ${layout.meta.verticalCount}）· 每 ${chunkSize} 辆一组`
        + ` · ${swappedPairs.length} 处组交换 · 开局 ${metrics.free} 辆可驶出`
        + `（队首同色 ${headMatch} 辆）· 依赖链 ${metrics.chain} 层 · 容量 ${capMix}`
        + ` · 至少 ${diversity.solutionCount} 个不同开局存在完整通关路径（共 ${diversity.openingLegal} 个开局合法可选）。`
        + `布局采用错落车列：纵向车列只占部分行、横向车道只占部分列，车辆之间穿插留白；`
        + `队列第一组与拓扑序前 ${chunkSize} 辆同色，保证开局有正反馈。`;
      level.hint =
        `队首是${COLOR_CN[headColor]}。开局有 ${metrics.free} 辆可驶出，其中 ${headMatch} 辆是${COLOR_CN[headColor]}，`
        + `先点它们最快。每辆车容量不同（2/4/6），看车位上的 x/y 计数即可知道何时满员离场。`
        + `之后每 ${chunkSize} 辆一组；若队首颜色暂时被挡住，先把前一组挡路车停进接客位，留出空位再接下一组。`;

      return {
        level,
        sim,
        metrics,
        key,
        chunkSize,
        swappedPairs,
        headMatch,
        diversity,
        palette,
      };
    }
  }
  throw new Error(`第 ${id} 关找不到满足协同设计约束的布局/队列`);
}

/* ---------------- 主流程 ---------------- */

function main() {
const levels = [];
const usedKeys = new Set();
const report = [];
for (let id = 10; id <= 50; id++) {
  const result = buildLevel(id, usedKeys);
  if (usedKeys.has(result.key)) throw new Error(`第 ${id} 关布局与之前重复`);
  usedKeys.add(result.key);
  levels.push(result.level);
  report.push({
    id,
    buses: result.level.buses.length,
    slots: result.level.slots,
    legal: result.metrics.free,
    headMatch: result.headMatch,
    maxFan: result.metrics.maxFan,
    chain: result.metrics.chain,
    group: result.chunkSize,
    swaps: result.swappedPairs.length,
    queue: result.level.queue.length,
    sim: result.sim,
    solutions: result.diversity.solutionCount,
    openings: result.diversity.openingLegal,
  });
  console.log(
    `第 ${id} 关 ${result.level.name}: ${result.level.buses.length} 辆 · ${result.level.slots} 位 · `
    + `${result.level.grid.cols}×${result.level.grid.rows} · 开局可动 ${result.metrics.free} / 队首同色 ${result.headMatch} · `
    + `扇出 ${result.metrics.maxFan} · 链 ${result.metrics.chain} · 每 ${result.chunkSize} 辆一组 · `
    + `交换 ${result.swappedPairs.length} 处 · 队列 ${result.level.queue.length} · 回放 ${result.sim.moves} 步 · `
    + `可行开局 ${result.diversity.solutionCount}/${result.diversity.openingLegal} ✅`
  );
}

const body = levels.map((lv) => {
  const busLines = lv.buses.map((b) => `      ${JSON.stringify(b)},`).join('\n');
  return `  {
    id: ${lv.id},
    difficulty: ${lv.difficulty},
    name: ${JSON.stringify(lv.name)},
    intent: ${JSON.stringify(lv.intent)},
    hint: ${JSON.stringify(lv.hint)},
    grid: ${JSON.stringify(lv.grid)},
    slots: ${lv.slots},
    buses: [
${busLines}
    ],
    queue: ${JSON.stringify(lv.queue)},
    solution: ${JSON.stringify(lv.solution)},
  },`;
}).join('\n\n');

const out = `/**
 * 第 10–50 关（由 tools/generate-levels.mjs 生成，请勿手改）
 * ------------------------------------------------------------
 * 生成规则：错落车列布局（纵向列只占部分行、横向车道只占部分列）
 * -> 阻挡拓扑序 -> 按 2/3 辆分组上色 -> 容量由车身长度映射（2/3/4 格 = 2/4/6 座）
 * -> 第一组先服务、后续相邻组按概率交换 -> 用 logic.js 回放验证。
 * 每关车辆数：第 10 关 31 辆，递增到第 50 关 60 辆；
 * 场地随难度从 12×12 增长到 15×15，保持通行与留白。
 * 队列长度 = 车辆总容量；参考解法 par = 车辆数。
 */
export const GENERATED_LEVELS = [
${body}
];
`;
fs.writeFileSync(new URL('../src/game/generatedLevels.js', import.meta.url), out);

const min = Math.min(...report.map((r) => r.buses));
const max = Math.max(...report.map((r) => r.buses));
const minLegal = Math.min(...report.map((r) => r.legal));
const minHead = Math.min(...report.map((r) => r.headMatch));
const maxFan = Math.max(...report.map((r) => r.maxFan));
console.log(`\n共生成 ${levels.length} 关：车辆 ${min}–${max} 辆，开局可动最少 ${minLegal} 辆，`
  + `队首同色最少 ${minHead} 辆，单点最大扇出 ${maxFan}，全部通过参考解回放。`);
console.log(`文件：src/game/generatedLevels.js`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}