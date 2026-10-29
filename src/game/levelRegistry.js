/**
 * 关卡注册表与配置校验（为 50 关规模做准备）
 * ------------------------------------------------------------
 * 职责：
 *  - 作为关卡数据的唯一访问入口：UI / 求解器 / 未来的关卡工具
 *    都从这里读取，不再散落 LEVELS.length、LEVELS[i] 等硬编码访问；
 *  - 统一的关卡配置校验（纯函数、无副作用）：格式、几何、数据一致性；
 *  - 明确的错误信息：配置缺失/非法时返回可读原因，而不是白屏或崩溃。
 *
 * 新增一关只需：在 levels.js 的 LEVELS 数组中追加一份配置对象，
 * 然后运行 `node src/game/solver.js`（会先做配置校验，再做 BFS 求解
 * 与参考解法回放）。无需改动任何核心逻辑 / UI 代码。
 *
 * ------------------------------------------------------------
 * 关卡配置格式（当前规则真实支持的全部字段）：
 * {
 *   id:        number   关卡编号（正整数，全局唯一）
 *   name:      string   关卡名称
 *   grid:      { cols, rows }           停车场网格（2..15 的整数）
 *   slots:     number                   接客位数量（全部关卡统一为 4）
 *   buses:     [{ id, color, len, dir, x, y, capacity? }]
 *              id: 关卡内唯一字符串；color: 颜色 key（见 COLORS）；
 *              len: 车身长度（格），必须与 capacity 严格对应：
 *                   2 座=2 格、4 座=3 格、6 座=4 格；
 *              dir: 'left'|'right'|'up'|'down'（车头=驶出方向）；
 *              x,y: 锚点格（水平车最左格、竖直车最上格），须在界内且不重叠；
 *              capacity: 每辆车独立的载客容量，必须是 2/4/6 之一
 *   queue:     string[] 候车乘客颜色序列，index 0 为队首
 *   solution?: { moves: string[], par: number }  参考解法（可选，建议提供，
 *              solver 会验证其真实有效性；par 会与 BFS 最短解比对）
 *   difficulty?: 1..5    难度标签（元数据，供选关/展示用）
 *   intent?:   string    设计意图/教学目标（策划文档用，不进 UI）
 *   hint?:     string    玩家提示（HUD「提示」按钮展示）
 * }
 *
 * 预留扩展方式（当前规则尚未支持、仅约定演进方向，未实现）：
 *  - 特殊车辆（如双向掉头）：未来在 bus 上增加类型字段，并在 logic.js
 *    的 validateMove/moveBus 中实现；配置校验同步放行新字段；
 *  - 障碍物：未来增加 obstacles 数组并在占用表中生效；
 *  - 操作步数限制等关卡目标：未来增加 goal 字段并在胜负判定中生效。
 * 在上述机制落地前，校验器会将未知机制字段视为警告而非通过，
 * 防止「写了配置但规则不支持」的虚假关卡。
 * ------------------------------------------------------------
 */
import {
  cellsOfBus,
  SLOT_COUNT,
  BUS_CAPACITIES,
  lengthForCapacity,
} from './logic.js';
import { LEVELS } from './levels.js';

/** 当前 UI 有配色的颜色集合（与 styles.css 的 .c-* 一一对应）。 */
export const COLORS = ['red', 'blue', 'green', 'purple', 'cyan', 'orange', 'yellow'];

const DIRS = ['left', 'right', 'up', 'down'];
const MIN_GRID = 2;
const MAX_GRID = 15;
const MAX_BUS_LEN = 4; // 6 座长车 = 4 格；容量/长度映射见 logic.js

const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * 校验单份关卡配置（纯格式/几何/数据一致性，不做求解）。
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateLevelConfig(level) {
  const errors = [];
  const warnings = [];
  if (!level || typeof level !== 'object') {
    return { ok: false, errors: ['关卡配置不是对象'], warnings };
  }
  const tag = `关卡 ${level.id ?? '?'}`;

  /* ---- 基本字段 ---- */
  if (!isInt(level.id) || level.id <= 0) errors.push(`${tag}: id 必须是正整数`);
  if (!isStr(level.name)) errors.push(`${tag}: name 缺失或为空`);

  /* ---- 网格 ---- */
  const g = level.grid;
  if (!g || !isInt(g.cols) || !isInt(g.rows) ||
      g.cols < MIN_GRID || g.rows < MIN_GRID || g.cols > MAX_GRID || g.rows > MAX_GRID) {
    errors.push(`${tag}: grid 必须是 ${MIN_GRID}..${MAX_GRID} 的整数 { cols, rows }`);
  }

  /* ---- 接客位：所有关卡统一 4 个 ---- */
  if (level.slots !== SLOT_COUNT) {
    errors.push(`${tag}: 接客位必须统一为 ${SLOT_COUNT} 个（当前 ${level.slots}）`);
  }

  /* ---- 巴士 ---- */
  const buses = level.buses;
  if (!Array.isArray(buses) || buses.length === 0) {
    errors.push(`${tag}: buses 不能为空`);
  } else {
    const ids = new Set();
    const occupied = new Map(); // 'x,y' -> busId
    for (const [i, b] of buses.entries()) {
      const btag = `${tag} 巴士[${b?.id ?? i}]`;
      if (!b || typeof b !== 'object') { errors.push(`${btag}: 不是对象`); continue; }
      if (!isStr(b.id)) errors.push(`${btag}: id 缺失或为空`);
      else if (ids.has(b.id)) errors.push(`${btag}: id 重复`);
      else ids.add(b.id);
      if (!isStr(b.color)) errors.push(`${btag}: color 缺失`);
      else if (!COLORS.includes(b.color)) warnings.push(`${btag}: color "${b.color}" 不在已配色集合（${COLORS.join('/')}），UI 将无颜色`);
      if (!isInt(b.len) || b.len < 1 || b.len > MAX_BUS_LEN) errors.push(`${btag}: len 必须是 1..${MAX_BUS_LEN} 的整数`);
      if (!DIRS.includes(b.dir)) errors.push(`${btag}: dir 必须是 ${DIRS.join('/')}`);
      if (!isInt(b.x) || !isInt(b.y)) errors.push(`${btag}: x/y 必须是整数`);
      if (b.capacity == null) {
        errors.push(`${btag}: 缺少 capacity（必须显式配置 ${BUS_CAPACITIES.join('/')}）`);
      } else if (!isInt(b.capacity) || !BUS_CAPACITIES.includes(b.capacity)) {
        errors.push(`${btag}: capacity 必须是 ${BUS_CAPACITIES.join('/')} 之一（当前 ${b.capacity}）`);
      } else if (isInt(b.len) && b.len !== lengthForCapacity(b.capacity)) {
        errors.push(
          `${btag}: 容量 ${b.capacity} 座必须使用 ${lengthForCapacity(b.capacity)} 格车身（当前 len=${b.len}）`
        );
      }
      // 几何：界内 + 不重叠（字段非法时跳过几何检查，避免级联报错）
      if (g && isInt(g.cols) && isInt(g.rows) && isInt(b?.x) && isInt(b?.y) &&
          isInt(b?.len) && DIRS.includes(b?.dir)) {
        for (const c of cellsOfBus(b)) {
          if (c.x < 0 || c.y < 0 || c.x >= g.cols || c.y >= g.rows) {
            errors.push(`${btag}: 越界（占据 ${c.x},${c.y}，网格 ${g.cols}x${g.rows}）`);
            continue;
          }
          const key = `${c.x},${c.y}`;
          if (occupied.has(key)) {
            errors.push(`${btag}: 与巴士 ${occupied.get(key)} 在 (${key}) 重叠`);
          } else {
            occupied.set(key, b.id);
          }
        }
      }
    }
  }

  /* ---- 候车队列 ---- */
  const queue = level.queue;
  if (!Array.isArray(queue) || queue.length === 0) {
    errors.push(`${tag}: queue 不能为空`);
  } else {
    for (const [i, c] of queue.entries()) {
      if (!isStr(c)) errors.push(`${tag}: queue[${i}] 不是颜色字符串`);
    }
  }

  /* ---- 队列与车辆的数据一致性（当前规则的硬性可赢前提） ---- */
  if (Array.isArray(buses) && Array.isArray(queue) && queue.length > 0) {
    const capByColor = new Map();
    for (const b of buses) {
      if (!isStr(b?.color)) continue;
      const cap = isInt(b.capacity) ? b.capacity : 2;
      capByColor.set(b.color, (capByColor.get(b.color) ?? 0) + cap);
    }
    const needByColor = new Map();
    for (const c of queue) needByColor.set(c, (needByColor.get(c) ?? 0) + 1);
    for (const [color, need] of needByColor) {
      const cap = capByColor.get(color) ?? 0;
      if (cap === 0) errors.push(`${tag}: 队列中有 ${need} 名 ${color} 乘客，但没有任何 ${color} 巴士`);
      else if (cap < need) errors.push(`${tag}: ${color} 乘客 ${need} 名，超过同色巴士总容量 ${cap}，数学上不可能运完`);
    }
    for (const b of buses) {
      if (isStr(b?.color) && !needByColor.has(b.color)) {
        warnings.push(`${tag}: 巴士 ${b.id}（${b.color}）在队列中没有同色乘客，会进位即发车`);
      }
    }
  }

  /* ---- 参考解法（可选；真实有效性由 solver 回放验证） ---- */
  if (level.solution != null) {
    const s = level.solution;
    if (!s || !Array.isArray(s.moves) || !isInt(s.par) || s.par < 1) {
      errors.push(`${tag}: solution 必须是 { moves: string[], par: ≥1 整数 }`);
    } else if (Array.isArray(buses)) {
      const idSet = new Set(buses.map((b) => b?.id));
      for (const m of s.moves) {
        if (!idSet.has(m)) errors.push(`${tag}: solution.moves 引用了不存在的巴士 "${m}"`);
      }
    }
  }

  /* ---- 元数据（可选） ---- */
  if (level.difficulty != null && (!isInt(level.difficulty) || level.difficulty < 1 || level.difficulty > 5)) {
    warnings.push(`${tag}: difficulty 建议使用 1..5 的整数`);
  }
  if (level.intent != null && typeof level.intent !== 'string') warnings.push(`${tag}: intent 应为字符串`);
  if (level.hint != null && typeof level.hint !== 'string') warnings.push(`${tag}: hint 应为字符串`);

  /* ---- 未实现机制的防护：发现未知顶层字段时提醒（防虚假配置） ---- */
  const KNOWN = ['id', 'name', 'grid', 'slots', 'buses', 'queue', 'solution', 'difficulty', 'intent', 'hint'];
  for (const k of Object.keys(level)) {
    if (!KNOWN.includes(k)) warnings.push(`${tag}: 未知字段 "${k}"（当前规则不支持，将被忽略）`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验整个注册表（含跨关卡的 id 唯一性）。 */
export function validateRegistry(levels = LEVELS) {
  const errors = [];
  const seen = new Map();
  for (const lv of levels) {
    const v = validateLevelConfig(lv);
    errors.push(...v.errors);
    if (lv && isInt(lv.id)) {
      if (seen.has(lv.id)) errors.push(`关卡 id ${lv.id} 重复`);
      seen.set(lv.id, true);
    }
  }
  return { ok: errors.length === 0, errors };
}

/* ---------------- 统一访问入口 ---------------- */

/** 关卡总数（UI 文案、循环跳关都以此为唯一来源）。 */
export function getLevelCount() {
  return LEVELS.length;
}

/**
 * 按序号（0 起）取关卡配置；越界返回 null（调用方负责给出可读错误）。
 */
export function getLevelByIndex(index) {
  if (!isInt(index) || index < 0 || index >= LEVELS.length) return null;
  return LEVELS[index];
}

/** 按关卡编号 id 取配置；不存在返回 null。 */
export function getLevelById(id) {
  return LEVELS.find((lv) => lv.id === id) ?? null;
}

/** 关卡摘要列表（选关页/调试工具用）。 */
export function listLevelSummaries() {
  return LEVELS.map((lv, i) => ({
    index: i,
    id: lv.id,
    name: lv.name,
    difficulty: lv.difficulty ?? null,
    par: lv.solution?.par ?? null,
  }));
}
