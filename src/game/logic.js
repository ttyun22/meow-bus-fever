/**
 * 《巴士大疏通》核心游戏逻辑
 * ------------------------------------------------------------
 * 纯数据模型 + 规则结算，不依赖任何 DOM / 渲染 / 定时器。
 * 浏览器 UI 与 Node 求解器（solver.js）共用同一套规则，
 * 保证「验证用的规则」与「实际游玩的规则」完全一致。
 *
 * ---------------- 状态模型 state ----------------
 * {
 *   levelId,                                     // 关卡编号
 *   grid:   { cols, rows },                      // 停车场网格
 *   slotCount: number,                           // 接客位数量
 *   slots:  [{ index, busId }],                  // busId 为 null 表示空位
 *   buses:  { id: Bus },                         // 全部巴士
 *   queue:  [{ color }],                         // 候车乘客，index 0 是队首（只有队首能上车）
 *   moveCount: number,                           // 玩家操作（点击驶出）次数
 *   status: 'playing' | 'won' | 'lost'
 * }
 *
 * Bus = {
 *   id, color, len, dir, capacity,              // dir: 'left'|'right'|'up'|'down'
 *   x, y,                                        // 棋盘锚点（status!=='board' 时为 null）
 *   status: 'board' | 'loading' | 'departed',    // 棋车上 | 接客位上 | 已发车离场
 *   slotIndex,                                   // status==='loading' 时所在的接客位
 *   passengers                                   // 已上车人数
 * }
 *
 * 一致性约定（防止状态错乱）：
 *  - 巴士是否占用棋盘格子只由 status==='board' 决定；
 *  - 巴士是否占用接客位只由 slots[i].busId 与 bus.slotIndex 双向同步决定；
 *    moveBus / departReady 是仅有的两个会同时改写两侧的入口。
 * ------------------------------------------------------------
 */

/* ---------------- 全局配置（唯一修改点） ---------------- */

/** 撤回等玩法外规则的统一配置，禁止散落各文件。 */
export const GAME_CONFIG = {
  /** 每关允许的撤回次数上限。 */
  UNDO_LIMIT: 2,
};

/* ---------------- 几何辅助 ---------------- */

/** 巴士在棋盘上占据的格子（锚点 + 长度，按朝向展开）。 */
export function cellsOfBus(bus) {
  const cells = [];
  if (bus.x == null || bus.y == null) return cells; // 防御：非棋盘上的巴士不占格
  if (bus.dir === 'left' || bus.dir === 'right') {
    for (let i = 0; i < bus.len; i++) cells.push({ x: bus.x + i, y: bus.y });
  } else {
    for (let i = 0; i < bus.len; i++) cells.push({ x: bus.x, y: bus.y + i });
  }
  return cells;
}

/** 驶出路径上需要清空的格子（车头到棋盘边缘，不含自身占据）。 */
export function exitPathOfBus(bus, grid) {
  const cells = [];
  if (bus.dir === 'right') {
    for (let x = bus.x + bus.len; x < grid.cols; x++) cells.push({ x, y: bus.y });
  } else if (bus.dir === 'left') {
    for (let x = 0; x < bus.x; x++) cells.push({ x, y: bus.y });
  } else if (bus.dir === 'down') {
    for (let y = bus.y + bus.len; y < grid.rows; y++) cells.push({ x: bus.x, y });
  } else if (bus.dir === 'up') {
    // 锚点是最上格：up 车头即锚点，路径是锚点上方的所有格子
    for (let y = 0; y < bus.y; y++) cells.push({ x: bus.x, y });
  }
  return cells;
}

/** 由所有 status==='board' 的巴士派生占用表：'x,y' -> busId。 */
export function buildOccupancy(state) {
  const map = new Map();
  for (const bus of Object.values(state.buses)) {
    if (bus.status !== 'board') continue;
    for (const c of cellsOfBus(bus)) map.set(`${c.x},${c.y}`, bus.id);
  }
  return map;
}

/* ---------------- 查询 ---------------- */

export function freeSlotCount(state) {
  return state.slots.filter((s) => s.busId == null).length;
}

function firstFreeSlot(state) {
  return state.slots.find((s) => s.busId == null)?.index ?? -1;
}

/** 某辆棋盘上的巴士驶出路径是否畅通（不含接客位判断）。 */
export function pathIsClear(bus, state, occ = buildOccupancy(state)) {
  return exitPathOfBus(bus, state.grid).every((c) => !occ.has(`${c.x},${c.y}`));
}

/** 队首乘客此刻是否有可上车的接客位巴士。 */
function findBoardableBus(state, color) {
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (bus.color === color && bus.passengers < bus.capacity) return bus.id;
  }
  return null;
}

/** 巴士是否满足发车条件：满载，或队列里已没有同色乘客（接完了）。 */
function canDepart(state, bus) {
  if (bus.passengers >= bus.capacity) return true;
  return !state.queue.some((p) => p.color === bus.color);
}

/** 玩家是否还有合法操作（有棋盘巴士此刻能驶出）。 */
export function anyLegalMove(state) {
  if (state.status !== 'playing') return false;
  if (freeSlotCount(state) === 0) return false;
  const occ = buildOccupancy(state);
  return Object.values(state.buses).some(
    (b) => b.status === 'board' && pathIsClear(b, state, occ)
  );
}

/* ---------------- 生命周期 ---------------- */

/**
 * initializeLevel：从关卡配置构建全新 state。
 * restartLevel 与其等价（同一配置重新初始化，保证关卡可重复）。
 */
export function initializeLevel(level) {
  const buses = {};
  for (const b of level.buses) {
    buses[b.id] = {
      id: b.id,
      color: b.color,
      len: b.len,
      dir: b.dir,
      capacity: b.capacity ?? b.len,
      x: b.x,
      y: b.y,
      status: 'board',
      slotIndex: null,
      passengers: 0,
    };
  }
  return {
    levelId: level.id,
    grid: { cols: level.grid.cols, rows: level.grid.rows },
    slotCount: level.slots,
    slots: Array.from({ length: level.slots }, (_, i) => ({ index: i, busId: null })),
    buses,
    queue: level.queue.map((c) => ({ color: c })),
    moveCount: 0,
    status: 'playing',
  };
}

/** 重新开始当前关卡：重置为初始状态。 */
export function restartLevel(level) {
  return initializeLevel(level);
}

/**
 * validateMove：验证点击某辆巴士驶出是否合法。
 * 返回 { ok, reason?, blockerId? }
 *  reason: 'not-playing' | 'not-on-board' | 'blocked' | 'no-slot'
 */
export function validateMove(state, busId) {
  if (state.status !== 'playing') return { ok: false, reason: 'not-playing' };
  const bus = state.buses[busId];
  if (!bus) return { ok: false, reason: 'unknown-bus' };
  if (bus.status !== 'board') return { ok: false, reason: 'not-on-board' };
  const occ = buildOccupancy(state);
  for (const c of exitPathOfBus(bus, state.grid)) {
    const blockerId = occ.get(`${c.x},${c.y}`);
    if (blockerId) return { ok: false, reason: 'blocked', blockerId, blockerCell: c };
  }
  if (freeSlotCount(state) === 0) return { ok: false, reason: 'no-slot' };
  return { ok: true };
}

/**
 * moveBus：执行一次合法驶出（棋盘 -> 接客位）。
 * 只做「驶出 + 到位」，上车/发车交给 boardPassengers / departReady 结算。
 * 返回 { ok, reason?, blockerId?, events }。
 * events: [ exit{busId,dir}, arrive{busId,slotIndex} ]，供 UI 播放动画。
 */
export function moveBus(state, busId) {
  const check = validateMove(state, busId);
  if (!check.ok) {
    return { ok: false, reason: check.reason, blockerId: check.blockerId };
  }
  const bus = state.buses[busId];
  const dir = bus.dir;
  const slotIndex = firstFreeSlot(state);

  // 同步更新两侧占用信息（巴士侧 + 接客位侧）
  state.slots[slotIndex].busId = busId;
  bus.slotIndex = slotIndex;
  bus.status = 'loading';
  bus.x = null;
  bus.y = null;

  state.moveCount += 1;
  return {
    ok: true,
    events: [
      { type: 'exit', busId, dir },
      { type: 'arrive', busId, slotIndex },
    ],
  };
}

/**
 * boardPassengers：结算自动上车。
 * 规则：队首乘客若有颜色匹配且未满载的接客位巴士，即上车（队列前移）。
 * 循环结算直到队首无法上车，或某辆巴士满载（先交给 departReady 发车）。
 * 返回本批 board 事件（UI 逐个播放动画）。
 */
export function boardPassengers(state) {
  const events = [];
  while (state.status === 'playing' && state.queue.length > 0) {
    const next = state.queue[0];
    const busId = findBoardableBus(state, next.color);
    if (busId == null) break; // 队首乘客没有可上的车，等待玩家操作
    const bus = state.buses[busId];
    state.queue.shift();
    bus.passengers += 1;
    events.push({ type: 'board', busId, slotIndex: bus.slotIndex, color: next.color });
    if (bus.passengers >= bus.capacity) break; // 满载，先发车再继续
  }
  return events;
}

/**
 * departReady：结算自动发车。
 * 规则：满载，或队列中已无同色乘客（该色任务完成）的接客位巴士立即发车离场，
 * 并释放接客位。返回本批 depart 事件。
 */
export function departReady(state) {
  const events = [];
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (!canDepart(state, bus)) continue;
    const slotIndex = slot.index;
    slot.busId = null; // 释放接客位
    bus.status = 'departed';
    bus.slotIndex = null;
    events.push({
      type: 'depart',
      busId: bus.id,
      slotIndex,
      color: bus.color,
      passengers: bus.passengers,
      capacity: bus.capacity,
    });
  }
  return events;
}

/** 反复结算上车/发车直到稳定（求解器 & 事件回放用）。 */
export function settleAll(state) {
  const events = [];
  for (;;) {
    const b = boardPassengers(state);
    const d = departReady(state);
    events.push(...b, ...d);
    if (b.length === 0 && d.length === 0) return events;
  }
}

/* ---------------- 胜负 ---------------- */

/**
 * checkWin：胜利 = 所有乘客上车且接客位清空（稳定态下自然成立）。
 * 命中时写入 status='won' 并返回 true（只允许触发一次）。
 */
export function checkWin(state) {
  if (state.status !== 'playing') return false;
  if (state.queue.length > 0) return false;
  if (state.slots.some((s) => s.busId != null)) return false;
  state.status = 'won';
  return true;
}

/**
 * checkLose：失败 = 局面稳定（无自动结算）且玩家没有任何合法操作，
 * 而乘客还没有运完。命中时写入 status='lost' 并返回 true。
 * 调用前提：本回合 boardPassengers / departReady 均已返回空（稳定态）。
 */
export function checkLose(state) {
  if (state.status !== 'playing') return false;
  if (state.queue.length === 0) return false; // 队列空只会走向胜利
  if (anyLegalMove(state)) return false;      // 还有车能驶出 -> 不算输
  state.status = 'lost';
  return true;
}

/** 死锁原因描述（供 UI 文案），在 checkLose 命中后调用。 */
export function loseReason(state) {
  if (freeSlotCount(state) === 0) {
    return '接客位全部被占满，而队首乘客上不了任何一辆车——新的巴士也进不来。';
  }
  return '剩下的巴士全被挡在停车场里，而队首乘客上不了任何一辆车。';
}
