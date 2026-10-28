/**
 * 《猫咪巴士大疏通》核心游戏逻辑
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
 *   slots:  [{ index, busId, extra }],           // busId 为 null 表示空位；extra=救援临时位
 *   buses:  { id: Bus },                         // 全部巴士
 *   waiting: [busId],                            // 等待进入接客位的车辆（FIFO，不占位）
 *   queue:  [{ id, color }],                     // 候车乘客，index 0 是队首（只有队首能上车）
 *   nextArrivalOrder: number,                    // 单调递增的接客位进入序号
 *   moveCount: number,                           // 玩家操作（点击驶出）次数
 *   status: 'playing' | 'won' | 'lost'
 * }
 *
 * Bus = {
 *   id, color, len, dir, capacity,              // dir: 'left'|'right'|'up'|'down'
 *   x, y,                                        // 棋盘锚点（board/waiting 时有效）
 *   status: 'board' | 'waiting' | 'moving' | 'loading' | 'departing' | 'completed',
 *   slotIndex,                                   // moving/loading 时所在的接客位
 *   arrivalOrder,                                // 进入接客位的先后序号（同色优先级）
 *   passengers                                   // 已上车人数（0..capacity）
 * }
 *
 * 状态语义：
 *  - board     在停车场里，可被点击；
 *  - waiting   已排队等待接客位，不占接客位，但仍占棋盘格；
 *  - moving    已分配接客位、正在驶入，占位但不可上车；
 *  - loading   已在接客位，可上车（boarding）；
 *  - departing 已满员/同色接完，接客位已原子释放，正在离站；
 *  - completed 离站动画结束，车辆最终完成。
 *
 * 一致性约定（防止状态错乱）：
 *  - 巴士是否占用棋盘格子由 status==='board' | 'waiting' 决定；
 *  - 巴士是否占用接客位只由 slots[i].busId 与 bus.slotIndex 双向同步决定；
 *    moveBus / dispatchWaiting / departReady 是仅有的会改写接客位所有权的入口；
 *  - 接客位释放后旧车辆只能变 completed，不允许再次释放接客位。
 * ------------------------------------------------------------
 */

/* ---------------- 全局配置（唯一修改点） ---------------- */

/** 撤回等玩法外规则的统一配置，禁止散落各文件。 */
export const GAME_CONFIG = {
  /** 保留的撤回快照上限（仅调试/历史记录用，HUD 不再提供撤回入口）。 */
  UNDO_LIMIT: 2,
  /** 每关允许的「增加临时停车位」救援次数。 */
  RESCUE_LIMIT: 2,
  /** 每次救援增加 1 个接客位；整关最多额外增加 2 个。 */
  EXTRA_SLOT_LIMIT: 2,
  /** 猫咪上车动画速度倍率：新耗时 = 原耗时 / 1.5。 */
  BOARDING_SPEED: 1.5,
};

/** 所有关卡统一使用的**基础**接客位数量（配置校验与生成器共用，与巴士容量无关）。 */
export const SLOT_COUNT = 4;

/** 每关最多可通过救援额外增加的接客位数量。 */
export const MAX_EXTRA_SLOTS = GAME_CONFIG.EXTRA_SLOT_LIMIT;

/**
 * 每辆巴士允许的载客容量。
 * 容量与车身长度严格一一对应：2 座=短车(2格)、4 座=中车(3格)、6 座=长车(4格)。
 * 容量是「每辆车独立的数据属性」，不同关卡、同一关卡内的不同车辆可以混用。
 */
export const BUS_CAPACITIES = [2, 4, 6];

/** 容量 -> 车身长度（格子数）。这是车辆视觉与实际占用区域的唯一映射。 */
export const BUS_LENGTH_BY_CAPACITY = Object.freeze({ 2: 2, 4: 3, 6: 4 });

/** 由容量得到车身长度；非法容量按 2 座兜底。 */
export function lengthForCapacity(capacity) {
  return BUS_LENGTH_BY_CAPACITY[capacity] ?? BUS_LENGTH_BY_CAPACITY[2];
}

/** 由车身长度反推容量；非法长度返回 null（仅用于旧数据迁移/校验）。 */
export function capacityForLength(len) {
  return BUS_CAPACITIES.find((cap) => lengthForCapacity(cap) === len) ?? null;
}

/** 把任意配置值归一化到允许的容量集合（仅用于旧数据/测试的兜底）。 */
export function normalizeCapacity(bus) {
  if (bus && BUS_CAPACITIES.includes(bus.capacity)) return bus.capacity;
  return capacityForLength(bus?.len) ?? 2;
}

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

/** 由所有仍占用棋盘格子的巴士派生占用表：'x,y' -> busId。 */
export function buildOccupancy(state) {
  const map = new Map();
  for (const bus of Object.values(state.buses)) {
    if (bus.status !== 'board' && bus.status !== 'waiting') continue;
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

/**
 * 同色车辆中，当前实际占据接客位且 arrivalOrder 最小的车辆。
 * moving / loading 都算「已进入接客位流程」；departing / completed 跳过。
 */
export function earliestSlotBusOfColor(state, color) {
  let earliest = null;
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (!bus || bus.slotIndex !== slot.index) continue;
    if (bus.status !== 'moving' && bus.status !== 'loading') continue;
    if (bus.color !== color) continue;
    if (!earliest || bus.arrivalOrder < earliest.arrivalOrder) earliest = bus;
  }
  return earliest;
}

/**
 * 队首乘客此刻是否有可上车的接客位巴士。
 * 同色优先级：必须先由 arrivalOrder 最小的同色车接客；
 * 若它仍在 moving（尚未到位），后面的同色车不能抢客。
 */
function findBoardableBus(state, color) {
  const earliest = earliestSlotBusOfColor(state, color);
  if (!earliest) return null;
  if (earliest.status === 'moving') return null;
  if (earliest.passengers < earliest.capacity) return earliest.id;
  return null;
}

/** 巴士是否满足发车条件：满载，或队列里已没有同色乘客（该色已接完）。 */
function canDepart(state, bus) {
  if (bus.passengers >= bus.capacity) return true;
  return !state.queue.some((p) => p.color === bus.color);
}

/** 是否有接客位巴士满足发车条件（稳定态诊断用）。 */
export function hasReadyDeparture(state) {
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (bus && bus.status === 'loading' && canDepart(state, bus)) return true;
  }
  return false;
}

/** 玩家是否还有可提交的车辆操作（有空位进场，或满位时加入等待队列）。 */
export function anyLegalMove(state) {
  if (state.status !== 'playing') return false;
  const occ = buildOccupancy(state);
  return Object.values(state.buses).some(
    (b) => b.status === 'board' && pathIsClear(b, state, occ)
  );
}

/** 是否存在仍在移动/上车/离站的车辆（通关前必须全部结束）。 */
export function hasPendingBusActivity(state) {
  return Object.values(state.buses).some(
    (b) => b.status === 'moving' || b.status === 'loading' || b.status === 'departing'
  );
}

/**
 * 是否存在尚未落定的异步转换（moving/departing）。
 * loading 是稳定可结算状态，不阻止失败判定：若队首能上，findBoardableBus
 * 会返回 false；若已满足发车，hasReadyDeparture 会返回 false。
 */
export function hasUnsettledTransitions(state) {
  return Object.values(state.buses).some(
    (b) => b.status === 'moving' || b.status === 'departing'
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
    const capacity = normalizeCapacity(b);
    buses[b.id] = {
      id: b.id,
      color: b.color,
      // 车身长度以容量映射为唯一来源：2/4/6 座 = 2/3/4 格。
      len: lengthForCapacity(capacity),
      dir: b.dir,
      capacity,
      x: b.x,
      y: b.y,
      status: 'board',
      slotIndex: null,
      arrivalOrder: null,
      passengers: 0,
    };
  }
  return {
    levelId: level.id,
    grid: { cols: level.grid.cols, rows: level.grid.rows },
    slotCount: level.slots,
    slots: Array.from({ length: level.slots }, (_, i) => ({ index: i, busId: null, extra: false })),
    buses,
    waiting: [],
    nextArrivalOrder: 1,
    queue: level.queue.map((c, i) => ({ id: `q${i}`, color: c })),
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
 * 满位不再视为非法：车辆会进入 waiting 队列（不占接客位）。
 * 返回 { ok, reason?, blockerId?, willWait? }
 *  reason: 'not-playing' | 'unknown-bus' | 'not-on-board' | 'blocked'
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
  return { ok: true, willWait: freeSlotCount(state) === 0 || state.waiting.length > 0 };
}

/** 原子地把车辆登记到接客位：slots[i].busId 与 bus.slotIndex 双向同步。 */
function assignSlot(state, bus, slotIndex) {
  const slot = state.slots[slotIndex];
  if (!slot || slot.busId != null) return false;
  slot.busId = bus.id;
  bus.slotIndex = slotIndex;
  bus.status = 'moving';
  bus.arrivalOrder = state.nextArrivalOrder;
  state.nextArrivalOrder += 1;
  bus.x = null;
  bus.y = null;
  return true;
}

/**
 * moveBus：执行一次合法驶出。
 * 有空位 -> 立即原子预留接客位（moving），动画结束后由 completeArrival 变为 loading；
 * 无空位 -> 进入 waiting 队列，不占接客位，也不阻塞后续点击。
 * 返回 { ok, reason?, blockerId?, queued?, events }。
 * events: [ exit{busId,dir}, arrive{busId,slotIndex} ] 或 [ wait{busId} ]。
 */
export function moveBus(state, busId) {
  const check = validateMove(state, busId);
  if (!check.ok) {
    return { ok: false, reason: check.reason, blockerId: check.blockerId };
  }
  const bus = state.buses[busId];
  const dir = bus.dir;
  const fromX = bus.x;
  const fromY = bus.y;
  const slotIndex = firstFreeSlot(state);

  // 没有空位，或已有更早的等待车辆：按 FIFO 排队，绝不占用接客位。
  if (slotIndex < 0 || state.waiting.length > 0) {
    bus.status = 'waiting';
    state.waiting.push(bus.id);
    state.moveCount += 1;
    return {
      ok: true,
      queued: true,
      events: [{ type: 'wait', busId, dir, fromX, fromY }],
    };
  }

  if (!assignSlot(state, bus, slotIndex)) {
    return { ok: false, reason: 'no-slot' }; // 防御：校验后仍无空位
  }
  state.moveCount += 1;
  return {
    ok: true,
    events: [
      { type: 'exit', busId, dir, fromX, fromY },
      { type: 'arrive', busId, slotIndex },
    ],
  };
}

/**
 * 把 waiting 队列头部车辆送入刚释放的接客位。
 * 只分配空闲接客位；路径仍被挡时保持等待，绝不提前占位。
 * 返回 dispatch 事件，供 UI 播放「驶出 + 到位」动画。
 */
export function dispatchWaiting(state) {
  const events = [];
  while (state.waiting.length > 0) {
    const slotIndex = firstFreeSlot(state);
    if (slotIndex < 0) break;

    // 按等待顺序找第一辆「此刻真的能驶出」的车。
    // 队首若被停车场里的其他等待车挡住，不能让它把整条队列锁死；
    // 先派可通行车辆，它离开后队首会在下一轮重新获得机会。
    const waitingIndex = state.waiting.findIndex((id) => {
      const candidate = state.buses[id];
      return candidate && candidate.status === 'waiting' && pathIsClear(candidate, state);
    });
    if (waitingIndex < 0) break; // 没有任何等待车辆可通行

    const busId = state.waiting[waitingIndex];
    state.waiting.splice(waitingIndex, 1);
    const bus = state.buses[busId];
    const fromX = bus.x;
    const fromY = bus.y;
    if (!assignSlot(state, bus, slotIndex)) break;
    events.push({
      type: 'dispatch',
      busId: bus.id,
      dir: bus.dir,
      slotIndex,
      fromX,
      fromY,
    });
  }
  return events;
}

/** 到位动画结束：moving -> loading，此后才允许上车。 */
export function completeArrival(state, busId) {
  const bus = state.buses[busId];
  if (!bus || bus.status !== 'moving') return null;
  if (bus.slotIndex == null || state.slots[bus.slotIndex]?.busId !== bus.id) return null;
  bus.status = 'loading';
  return { type: 'arrived', busId, slotIndex: bus.slotIndex };
}

/** 场地内所有 moving 车辆立即到位（求解器/批量结算用）。 */
export function completeAllArrivals(state) {
  const events = [];
  for (const bus of Object.values(state.buses)) {
    if (bus.status !== 'moving') continue;
    const ev = completeArrival(state, bus.id);
    if (ev) events.push(ev);
  }
  return events;
}

/** 离站动画结束：departing -> completed。只改车辆状态，绝不再碰接客位。 */
export function completeDeparture(state, busId) {
  const bus = state.buses[busId];
  if (!bus || bus.status !== 'departing') return null;
  bus.status = 'completed';
  return { type: 'completed', busId: bus.id };
}

/** 批量完成离站（求解器/批量结算用）。 */
export function completeAllDepartures(state) {
  const events = [];
  for (const bus of Object.values(state.buses)) {
    if (bus.status !== 'departing') continue;
    const ev = completeDeparture(state, bus.id);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * boardOnePassenger：只结算「队首的一名乘客」上车。
 * 供 UI 逐只播放猫咪走动/登车动画；求解器仍可用 boardPassengers 批量结算。
 * 返回 board 事件或 null（队首没有可上的车）。
 */
export function boardOnePassenger(state) {
  if (state.status !== 'playing' || state.queue.length === 0) return null;
  const next = state.queue[0];
  const busId = findBoardableBus(state, next.color);
  if (busId == null) return null;
  const bus = state.buses[busId];
  state.queue.shift();
  bus.passengers += 1;
  return { type: 'board', busId, slotIndex: bus.slotIndex, color: next.color, passengerId: next.id };
}

/**
 * boardPassengers：结算自动上车（批量）。
 * 规则：队首乘客若有颜色匹配且未满载的接客位巴士，即上车（队列前移）。
 * 循环结算直到队首无法上车，或某辆巴士满载（先交给 departReady 发车）。
 * 返回本批 board 事件（UI 逐个播放动画）。
 */
export function boardPassengers(state) {
  const events = [];
  while (state.status === 'playing' && state.queue.length > 0) {
    const ev = boardOnePassenger(state);
    if (!ev) break;
    events.push(ev);
    if (state.buses[ev.busId].passengers >= state.buses[ev.busId].capacity) break; // 满载，先发车再继续
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
    if (!bus || (bus.status !== 'loading' && bus.status !== 'moving') || bus.slotIndex !== slot.index) {
      // 防御性修复：接客位里不是一辆正常占用中的巴士，直接释放，避免永久占位。
      slot.busId = null;
      continue;
    }
    // moving 车辆尚未到位，不允许在到位前发车；等它 loading 后再结算。
    if (bus.status !== 'loading') continue;
    if (!canDepart(state, bus)) continue;
    const slotIndex = slot.index;
    slot.busId = null; // 原子释放接客位
    bus.slotIndex = null;
    bus.arrivalOrder = null;
    bus.status = 'departing'; // 禁止继续上客；动画结束后再变 completed
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

/**
 * 反复结算「到位 -> 上车 -> 发车 -> 等待车辆进场」直到稳定。
 * 纯逻辑环境（求解器/测试）会立即完成到达与离站；UI 只在撤回时使用。
 */
export function settleAll(state) {
  const events = [];
  for (;;) {
    events.push(...completeAllArrivals(state));
    const b = boardPassengers(state);
    const d = departReady(state);
    const w = dispatchWaiting(state);
    events.push(...b, ...d, ...w);
    if (b.length === 0 && d.length === 0 && w.length === 0) break;
  }
  events.push(...completeAllDepartures(state));
  return events;
}

/* ---------------- 免费救援 / 队列调整 ---------------- */

/** 队首猫咪此刻是否能上某辆 loading 状态的接客位巴士（含同色先到先得）。 */
export function queueHeadCanBoard(state) {
  if (!state || state.queue.length === 0) return false;
  return findBoardableBus(state, state.queue[0].color) != null;
}

/**
 * 队首是否还有「正常操作」可走：接客位能上，或空位 + 同色棋盘车可驶出。
 * 用于区分「需要救援的卡点」与「只是还没点对车」。
 */
export function queueHeadCanBeServedNow(state) {
  if (!state || state.queue.length === 0) return false;
  if (queueHeadCanBoard(state)) return true;
  if (freeSlotCount(state) === 0) return false;
  const occ = buildOccupancy(state);
  const headColor = state.queue[0].color;
  return Object.values(state.buses).some(
    (bus) => bus.status === 'board'
      && bus.color === headColor
      && pathIsClear(bus, state, occ)
  );
}

/**
 * 寻找一次有意义的队列调整：
 *  - 只考虑「队列后方存在、调到队首后马上能上车」的颜色；
 *  - 优先接客位里已经停着的巴士（能立即接客/发车/释放位置）；
 *  - 其次考虑接客位有空位、且当前路径畅通的棋盘巴士；
 *  - 队首本来就能通过正常操作服务时不建议救援。
 * 返回 { color, queueIndex, kind, busId } 或 null。
 */
export function findRescueTarget(state) {
  if (!state || state.queue.length < 2) return null;
  if (queueHeadCanBeServedNow(state)) return null;

  const candidates = [];
  const firstLaterIndexOf = (color) => {
    for (let i = 1; i < state.queue.length; i++) {
      if (state.queue[i].color === color) return i;
    }
    return -1;
  };

  // 1) 接客位上的巴士：优先，因为调整后能立刻产生发车/空位。
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (!bus || bus.status !== 'loading' || bus.passengers >= bus.capacity) continue;
    const idx = firstLaterIndexOf(bus.color);
    if (idx > 0) {
      candidates.push({
        color: bus.color,
        queueIndex: idx,
        kind: 'slot',
        busId: bus.id,
        priority: 0,
      });
    }
  }

  // 2) 棋盘上当前可驶出、且有空接客位的同色巴士。
  if (freeSlotCount(state) > 0) {
    const occ = buildOccupancy(state);
    for (const bus of Object.values(state.buses)) {
      if (bus.status !== 'board' || !pathIsClear(bus, state, occ)) continue;
      const idx = firstLaterIndexOf(bus.color);
      if (idx > 0) {
        candidates.push({
          color: bus.color,
          queueIndex: idx,
          kind: 'board',
          busId: bus.id,
          priority: 1,
        });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.priority - b.priority || a.queueIndex - b.queueIndex);
  return candidates[0];
}

/**
 * rescueQueue：一次性免费救援。
 * 把目标颜色的全部猫咪按原相对顺序移到队首，让已经停在接客位的巴士
 * 能够完成接客并离开；不删除、不新增猫咪，不改变车辆与载客数。
 * 调用方负责在 lost 状态下先把 status 改回 playing。
 */
export function rescueQueue(state) {
  if (!state || state.status === 'won' || state.queue.length === 0) {
    return { ok: false, reason: 'nothing-to-rescue' };
  }
  const target = findRescueTarget(state);
  if (!target) return { ok: false, reason: 'no-rescue-target' };

  const moved = state.queue.filter((p) => p.color === target.color);
  const rest = state.queue.filter((p) => p.color !== target.color);
  if (moved.length === 0) return { ok: false, reason: 'no-rescue-target' };
  state.queue = [...moved, ...rest];

  return {
    ok: true,
    color: target.color,
    busId: target.busId,
    kind: target.kind,
    movedCount: moved.length,
    fromIndex: target.queueIndex,
  };
}

/**
 * useRescue：带剩余次数预算的一次救援（控制器与测试共用）。
 * 只有真正执行成功才扣 1 次；预算为 0 时不会修改任何状态。
 * 返回 { ok, rescueLeft, ...rescueResult }。
 */
export function useRescue(state, remaining) {
  const left = Math.max(0, Number.isInteger(remaining) ? remaining : 0);
  if (!state || state.status === 'won') {
    return { ok: false, reason: 'nothing-to-rescue', rescueLeft: left };
  }
  if (left <= 0) return { ok: false, reason: 'no-rescue-left', rescueLeft: 0 };

  const wasLost = state.status === 'lost';
  if (wasLost) state.status = 'playing'; // 失败覆盖层允许救援
  const res = rescueQueue(state);
  if (!res.ok) {
    if (wasLost) state.status = 'lost';
    return { ...res, rescueLeft: left };
  }
  return { ...res, rescueLeft: left - 1 };
}

/* ---------------- 临时停车位救援 ---------------- */

/** 当前已经额外增加的接客位数量。 */
export function extraSlotCount(state) {
  return state?.slots?.filter((s) => s.extra).length ?? 0;
}

/**
 * 增加停车位救援：临时追加 1 个接客位。
 * - 每关最多额外增加 MAX_EXTRA_SLOTS 个；
 * - 只增删接客位，不改变车辆颜色/容量/载客规则；
 * - 只有真正执行成功才扣 1 次（预算为 0 / 已通关 / 已满额时不改状态）；
 * - 允许在失败覆盖层使用（先恢复 playing，若仍无路可走会再次判负）。
 * 返回 { ok, reason?, slotLeft, slotCount?, slotIndex?, resumed? }。
 */
export function addTemporarySlot(state, remaining) {
  const left = Math.max(0, Number.isInteger(remaining) ? remaining : 0);
  if (!state) return { ok: false, reason: 'no-state', slotLeft: left };
  if (state.status === 'won') return { ok: false, reason: 'already-won', slotLeft: left };
  if (!Array.isArray(state.slots) || state.slots.length < SLOT_COUNT) {
    return { ok: false, reason: 'invalid-state', slotLeft: left };
  }
  if (left <= 0) return { ok: false, reason: 'no-rescue-left', slotLeft: 0 };
  if (extraSlotCount(state) >= MAX_EXTRA_SLOTS) {
    return { ok: false, reason: 'slot-limit', slotLeft: left };
  }

  const wasLost = state.status === 'lost';
  if (wasLost) state.status = 'playing';
  const index = state.slots.length;
  state.slots.push({ index, busId: null, extra: true });
  state.slotCount = state.slots.length;
  return {
    ok: true,
    slotIndex: index,
    slotCount: state.slots.length,
    extraSlots: extraSlotCount(state),
    slotLeft: left - 1,
    resumed: wasLost,
  };
}

/**
 * 当前局面是否值得使用「增加停车位」：
 *  - 已经没有次数 / 已满额 / 已通关 -> 不可用；
 *  - 有可驶出的棋盘车辆，新位置才有机会被使用；
 *  - 还有空位且没有等待车辆时仍允许使用，但会提示收益可能不高。
 * 返回 { ok, reason, availableBuses, freeSlots }。
 */
export function evaluateAddSlot(state, remaining) {
  const left = Math.max(0, Number.isInteger(remaining) ? remaining : 0);
  if (!state) return { ok: false, reason: 'no-state', left };
  if (state.status === 'won') return { ok: false, reason: 'already-won', left };
  if (left <= 0) return { ok: false, reason: 'no-rescue-left', left };
  if (extraSlotCount(state) >= MAX_EXTRA_SLOTS) return { ok: false, reason: 'slot-limit', left };
  if (state.queue.length === 0) return { ok: false, reason: 'queue-empty', left };
  if (hasUnsettledTransitions(state)) return { ok: false, reason: 'busy', left };

  const occ = buildOccupancy(state);
  const availableBuses = Object.values(state.buses)
    .filter((b) => b.status === 'board' && pathIsClear(b, state, occ))
    .map((b) => b.id);
  if (availableBuses.length === 0) {
    return { ok: false, reason: 'no-exit-bus', left, availableBuses, freeSlots: freeSlotCount(state) };
  }
  const freeSlots = freeSlotCount(state);
  const headColor = state.queue[0]?.color;
  const headAvailable = availableBuses.some((id) => state.buses[id]?.color === headColor);
  return {
    ok: true,
    reason: freeSlots === 0 ? 'slots-full' : 'has-free-slot',
    left,
    availableBuses,
    freeSlots,
    headAvailable,
  };
}

/* ---------------- 胜负 ---------------- */

/**
 * checkWin：胜利 = 所有乘客已处理、接客位清空，且没有正在移动/上车/离站的车辆。
 * waiting 车辆和停在棋盘上的未使用车辆不阻止胜利（关卡目标是运完猫咪）。
 */
export function checkWin(state) {
  if (state.status !== 'playing') return false;
  if (state.queue.length > 0) return false;
  if (state.slots.some((s) => s.busId != null)) return false;
  if (hasPendingBusActivity(state)) return false;
  state.status = 'won';
  return true;
}

/**
 * checkLose：真死局判定。必须同时满足：
 *  1. 局面稳定：没有 moving/loading/departing；
 *  2. 队首无法上任何接客位车辆（包含同色先到先得约束）；
 *  3. 接客位里没有车辆能自动发车；
 *  4. 没有「空位 + 可驶出车辆」这种还能继续操作的状态。
 *
 * 注意：四格全满本身永远不会直接判负；满位且仍有车能上客/发车时也不算输。
 * 满位时新车辆进入 waiting 队列只是排队，不会让局面变成可推进；
 * 因此 waiting 队列非空但四格全是错误颜色时，仍应如实判为死局。
 */
export function checkLose(state) {
  if (state.status !== 'playing') return false;
  if (state.queue.length === 0) return false;
  if (hasUnsettledTransitions(state)) return false;

  const headColor = state.queue[0].color;
  if (findBoardableBus(state, headColor) != null) return false;
  if (hasReadyDeparture(state)) return false;

  // 只有「有空位且确实有车能驶出」才是可继续的普通局面。
  if (freeSlotCount(state) > 0 && anyLegalMove(state)) return false;

  state.status = 'lost';
  return true;
}

/** 死锁原因描述（供 UI 文案），在 checkLose 命中后调用。 */
export function loseReason(state) {
  if (freeSlotCount(state) === 0) {
    const waited = state.waiting.length > 0 ? `（另有 ${state.waiting.length} 辆等待进入）` : '';
    return `${state.slots.length} 个接客位都被暂时接不到队首猫咪的车辆占满${waited}，等待队列也无法推进。`;
  }
  if (state.waiting.length > 0) {
    return '等待进入的车辆被停车场里的车辆挡住，队首猫咪也上不了任何接客位车辆。';
  }
  return '剩下的巴士全被挡在停车场里，而队首乘客上不了任何一辆车。';
}

/* ---------------- 状态一致性自检（测试/调试用） ---------------- */

/**
 * 检查接客位与车辆状态是否双向一致。
 * 只读，不修改 state；返回 { ok, errors }。
 * 用于自动化测试、调试面板与关键路径回归，避免「重复占用 / 重复释放 /
 * 载客数越界 / 已发车车辆仍占位」这类隐性状态损坏。
 */
export function validateStateInvariants(state) {
  const errors = [];
  if (!state || typeof state !== 'object') return { ok: false, errors: ['state 为空'] };
  const maxSlots = SLOT_COUNT + MAX_EXTRA_SLOTS;
  if (!Array.isArray(state.slots) || state.slots.length < SLOT_COUNT || state.slots.length > maxSlots) {
    errors.push(`接客位数量应为 ${SLOT_COUNT}..${maxSlots}（含临时位）`);
    return { ok: false, errors };
  }
  if (state.slotCount != null && state.slotCount !== state.slots.length) {
    errors.push(`state.slotCount=${state.slotCount}，应为 ${state.slots.length}`);
  }
  const extraSlots = state.slots.filter((s) => s.extra).length;
  if (extraSlots > MAX_EXTRA_SLOTS) {
    errors.push(`临时接客位 ${extraSlots} 个，超过上限 ${MAX_EXTRA_SLOTS}`);
  }
  for (let i = 0; i < state.slots.length; i++) {
    const shouldBeExtra = i >= SLOT_COUNT;
    if (!!state.slots[i].extra !== shouldBeExtra) {
      errors.push(`接客位 ${i} 的 extra 标记应为 ${shouldBeExtra}`);
    }
  }
  if (!Array.isArray(state.waiting)) {
    errors.push('state.waiting 必须是数组');
  }

  const used = new Map(); // busId -> slotIndex
  const arrivalOrders = new Map();
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (!bus) {
      errors.push(`接客位 ${slot.index} 引用了不存在的巴士 ${slot.busId}`);
      continue;
    }
    if (used.has(slot.busId)) {
      errors.push(`巴士 ${slot.busId} 同时占用接客位 ${used.get(slot.busId)} 和 ${slot.index}`);
    }
    used.set(slot.busId, slot.index);
    if (bus.status !== 'loading' && bus.status !== 'moving') {
      errors.push(`巴士 ${bus.id} 占用接客位但状态为 ${bus.status}`);
    }
    if (bus.slotIndex !== slot.index) {
      errors.push(`巴士 ${bus.id} slotIndex=${bus.slotIndex} 与接客位 ${slot.index} 不一致`);
    }
    if (!Number.isInteger(bus.arrivalOrder)) {
      errors.push(`巴士 ${bus.id} 占用接客位但缺少 arrivalOrder`);
    } else if (arrivalOrders.has(bus.arrivalOrder)) {
      errors.push(`arrivalOrder ${bus.arrivalOrder} 重复：${arrivalOrders.get(bus.arrivalOrder)} / ${bus.id}`);
    } else {
      arrivalOrders.set(bus.arrivalOrder, bus.id);
    }
  }

  const waitingIds = new Set();
  for (const busId of state.waiting ?? []) {
    if (waitingIds.has(busId)) errors.push(`等待队列重复登记巴士 ${busId}`);
    waitingIds.add(busId);
    const bus = state.buses[busId];
    if (!bus) {
      errors.push(`等待队列引用了不存在的巴士 ${busId}`);
    } else if (bus.status !== 'waiting') {
      errors.push(`巴士 ${busId} 在等待队列但状态为 ${bus.status}`);
    } else if (bus.slotIndex != null) {
      errors.push(`巴士 ${busId} 等待中却占用了接客位 ${bus.slotIndex}`);
    }
  }

  const seenIds = new Set();
  for (const bus of Object.values(state.buses)) {
    if (seenIds.has(bus.id)) errors.push(`巴士 id 重复：${bus.id}`);
    seenIds.add(bus.id);
    if (!Number.isInteger(bus.passengers) || bus.passengers < 0 || bus.passengers > bus.capacity) {
      errors.push(`巴士 ${bus.id} 载客数 ${bus.passengers}/${bus.capacity} 越界`);
    }
    if (!BUS_CAPACITIES.includes(bus.capacity)) {
      errors.push(`巴士 ${bus.id} 容量 ${bus.capacity} 不在允许值 ${BUS_CAPACITIES.join('/')}`);
    } else if (bus.len !== lengthForCapacity(bus.capacity)) {
      errors.push(`巴士 ${bus.id} 容量 ${bus.capacity} 对应车身 ${lengthForCapacity(bus.capacity)} 格，实际 ${bus.len} 格`);
    }
    if (bus.status === 'loading' || bus.status === 'moving') {
      if (bus.slotIndex == null || state.slots[bus.slotIndex]?.busId !== bus.id) {
        errors.push(`巴士 ${bus.id} 处于 ${bus.status} 但未正确登记接客位`);
      }
      if (bus.x != null || bus.y != null) errors.push(`巴士 ${bus.id} 已进入接客位但仍占用棋盘坐标`);
    } else if (bus.status === 'departing' || bus.status === 'completed') {
      if (bus.slotIndex != null) errors.push(`巴士 ${bus.id} 处于 ${bus.status} 但 slotIndex 未清空`);
      if (bus.x != null || bus.y != null) errors.push(`巴士 ${bus.id} 处于 ${bus.status} 但仍占用棋盘坐标`);
    } else if (bus.status === 'board' || bus.status === 'waiting') {
      if (bus.slotIndex != null) errors.push(`巴士 ${bus.id} 在停车场但 slotIndex 未清空`);
      if (bus.x == null || bus.y == null) errors.push(`巴士 ${bus.id} 在停车场但缺少坐标`);
      if (bus.status === 'waiting' && !waitingIds.has(bus.id)) {
        errors.push(`巴士 ${bus.id} 处于 waiting 但不在等待队列`);
      }
      if (bus.status === 'board' && waitingIds.has(bus.id)) {
        errors.push(`巴士 ${bus.id} 在等待队列但状态为 board`);
      }
    } else {
      errors.push(`巴士 ${bus.id} 状态未知：${bus.status}`);
    }
  }

  const maxArrivalOrder = Math.max(0, ...arrivalOrders.keys());
  if (!Number.isInteger(state.nextArrivalOrder) || state.nextArrivalOrder <= maxArrivalOrder) {
    errors.push(`nextArrivalOrder=${state.nextArrivalOrder} 必须大于已使用的 arrivalOrder ${maxArrivalOrder}`);
  }

  if (state.queue.length > 0) {
    const qids = new Set();
    for (const p of state.queue) {
      if (qids.has(p.id)) errors.push(`乘客 id 重复：${p.id}`);
      qids.add(p.id);
    }
  }
  return { ok: errors.length === 0, errors };
}
