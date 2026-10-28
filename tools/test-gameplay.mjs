/**
 * 规则层验收测试（不依赖浏览器）
 * ------------------------------------------------------------
 * 覆盖本次修复：
 *  - waiting/moving/loading/departing/completed 状态与接客位所有权；
 *  - 4 个接客位满载时进入等待队列，任一车位释放后按 FIFO 进场；
 *  - 同色车辆严格按进入接客位的 arrivalOrder 先来后到；
 *  - 真死局与「暂时没有空位/暂时没有匹配猫」的区分；
 *  - 容量 2/4/6 与车身长度 2/3/4 格、视觉和实际占用严格一致；
 *  - 上车提速 1.5 倍后仍逐只上车、不重复、不越界；
 *  - 每关 3 次救援预算，成功才扣次数，第 4 次不执行；
 *  - 50 关配置、参考解回放、连续重开/撤回的状态一致性。
 *
 * 运行：npm test
 */
import {
  initializeLevel,
  validateMove,
  moveBus,
  boardOnePassenger,
  boardPassengers,
  departReady,
  dispatchWaiting,
  completeArrival,
  completeAllArrivals,
  completeDeparture,
  completeAllDepartures,
  settleAll,
  checkWin,
  checkLose,
  validateStateInvariants,
  freeSlotCount,
  findRescueTarget,
  rescueQueue,
  useRescue,
  addTemporarySlot,
  evaluateAddSlot,
  extraSlotCount,
  MAX_EXTRA_SLOTS,
  queueHeadCanBoard,
  hasReadyDeparture,
  anyLegalMove,
  cellsOfBus,
  buildOccupancy,
  GAME_CONFIG,
  SLOT_COUNT,
  BUS_CAPACITIES,
  BUS_LENGTH_BY_CAPACITY,
  lengthForCapacity,
} from '../src/game/logic.js';
import { analyzeLevel, evaluateMoveRisk, findPath } from '../src/game/search.js';
import { buildSmartHint, describeMoveRisk, describeAddSlot } from '../src/game/hints.js';
import { busSvgMarkup } from '../src/ui/render.js';
import { LEVELS } from '../src/game/levels.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertInvariants(label, state) {
  const v = validateStateInvariants(state);
  check(`${label}：状态一致性`, v.ok, v.errors.join('; '));
}

function baseLevel(overrides = {}) {
  return {
    id: 900,
    name: '测试关',
    grid: { cols: 8, rows: 10 },
    slots: SLOT_COUNT,
    buses: [],
    queue: [],
    ...overrides,
  };
}

/** 按容量生成合法车辆：2 座=2 格、4 座=3 格、6 座=4 格。 */
function rowBus(id, color, row, capacity = 2, overrides = {}) {
  return {
    id,
    color,
    len: lengthForCapacity(capacity),
    dir: 'right',
    x: 0,
    y: row,
    capacity,
    ...overrides,
  };
}

/** 提交驶出并立即完成到位（纯逻辑测试通常不需要动画等待）。 */
function enter(state, busId) {
  const res = moveBus(state, busId);
  if (res.ok && !res.queued) completeAllArrivals(state);
  return res;
}

const isCompleted = (bus) => bus.status === 'completed';
const isDeparting = (bus) => bus.status === 'departing';

function deadlockWithFourRedBuses() {
  const level = baseLevel({
    buses: [
      rowBus('r1', 'red', 0, 2),
      rowBus('r2', 'red', 1, 2),
      rowBus('r3', 'red', 2, 2),
      rowBus('r4', 'red', 3, 2),
      rowBus('b1', 'blue', 4, 2),
    ],
    queue: ['blue', 'blue', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red'],
  });
  const state = initializeLevel(level);
  for (const id of ['r1', 'r2', 'r3', 'r4']) enter(state, id);
  return state;
}

/* ================= 1. 连续提交 / 满位排队 ================= */
console.log('\n[1] 连续快速提交多辆车：满位进入等待队列，不锁死操作');
{
  const colors = ['red', 'blue', 'green', 'purple', 'yellow'];
  const level = baseLevel({
    buses: colors.map((c, i) => rowBus(`b${i + 1}`, c, i, 2)),
    queue: colors.flatMap((c) => [c, c]),
  });
  const state = initializeLevel(level);
  assertInvariants('初始', state);

  for (let i = 1; i <= SLOT_COUNT; i++) {
    const res = moveBus(state, `b${i}`);
    check(`第 ${i} 辆合法车立即提交成功`, res.ok && !res.queued, JSON.stringify(res));
  }
  check('4 辆车处于 moving（动画未到位）', ['b1', 'b2', 'b3', 'b4'].every((id) => state.buses[id].status === 'moving'));
  completeAllArrivals(state);
  check('到位后 4 辆车变为 loading', ['b1', 'b2', 'b3', 'b4'].every((id) => state.buses[id].status === 'loading'));
  check('4 个接客位无重复占用', new Set(state.slots.map((s) => s.busId)).size === SLOT_COUNT);
  check('每辆车都拿到唯一 arrivalOrder', new Set(['b1', 'b2', 'b3', 'b4'].map((id) => state.buses[id].arrivalOrder)).size === 4);
  check('操作数只增加 4 次', state.moveCount === 4, `实际 ${state.moveCount}`);
  assertInvariants('4 辆到位', state);

  const before = JSON.stringify(state);
  const extra = moveBus(state, 'b5');
  check('满位时第 5 辆仍可点击并加入等待队列', extra.ok && extra.queued, JSON.stringify(extra));
  check('等待车辆不占接客位', state.buses.b5.status === 'waiting' && state.buses.b5.slotIndex == null);
  check('等待队列按点击顺序登记', state.waiting.length === 1 && state.waiting[0] === 'b5');
  check('接客位仍只有 4 个所有者', state.slots.filter((s) => s.busId != null).length === 4);
  check('操作数增加 1 次', state.moveCount === 5);
  check('唯一发生的变化是等待队列，不存在重复占位', state.slots.map((s) => s.busId).join(',') === 'b1,b2,b3,b4');
  assertInvariants('满位等待', state);

  const beforeArrival = JSON.stringify(state);
  const again = moveBus(state, 'b5');
  check('同一辆等待车不会被重复派出', !again.ok && JSON.stringify(state) === beforeArrival);

  const events = settleAll(state);
  const boardEvents = events.filter((e) => e.type === 'board');
  const passengerIds = boardEvents.map((e) => e.passengerId);
  check('等待车在车位释放后自动进场', state.buses.b5.passengers === 2 && isCompleted(state.buses.b5));
  check('5 辆车全部完成且各只离场一次', colors.every((_, i) => isCompleted(state.buses[`b${i + 1}`]))
    && events.filter((e) => e.type === 'depart').length === 5);
  check('每只猫只上车一次', new Set(passengerIds).size === passengerIds.length && passengerIds.length === 10);
  check('自动结算后接客位全部释放', freeSlotCount(state) === SLOT_COUNT);
  check('不会因为满位而判负', state.status !== 'lost');
  check('全部猫咪运完即通关', checkWin(state) && state.status === 'won');
  assertInvariants('排队闭环后', state);
}

/* ================= 2. 满位仍可周转 ================= */
console.log('\n[2] 4 个接客位全满时，已有巴士继续接客 / 发车 / 释放');
{
  const level = baseLevel({
    buses: [
      rowBus('r1', 'red', 0, 2),
      rowBus('r2', 'red', 1, 2),
      rowBus('r3', 'red', 2, 2),
      rowBus('r4', 'red', 3, 2),
      rowBus('b1', 'blue', 4, 2),
    ],
    queue: ['red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'blue', 'blue'],
  });
  const state = initializeLevel(level);
  for (const id of ['r1', 'r2', 'r3', 'r4']) enter(state, id);
  check('4 个接客位已全部占用', freeSlotCount(state) === 0);
  check('满位瞬间不判负', checkLose(state) === false);

  const departures = new Map();
  for (;;) {
    const b = boardPassengers(state);
    const d = departReady(state);
    for (const ev of d) departures.set(ev.busId, (departures.get(ev.busId) ?? 0) + 1);
    for (const ev of d) completeDeparture(state, ev.busId);
    if (b.length === 0 && d.length === 0) break;
  }
  check('4 辆等待中的红巴士全部完成', ['r1', 'r2', 'r3', 'r4'].every((id) => isCompleted(state.buses[id])));
  check('每辆车只离场一次', [...departures.values()].every((n) => n === 1), JSON.stringify([...departures]));
  check('接客位全部释放', freeSlotCount(state) === SLOT_COUNT);
  check('红猫全部被接走', state.queue.every((p) => p.color !== 'red'));
  check('蓝巴士仍可进场并完成本关', enter(state, 'b1').ok && settleAll(state) && checkWin(state));
  assertInvariants('闭环后', state);
}

/* ================= 3. FIFO 上车顺序 ================= */
console.log('\n[3] 猫头上车顺序与队列顺序一致');
{
  const level = baseLevel({
    grid: { cols: 6, rows: 3 },
    buses: [rowBus('r1', 'red', 0, 2), rowBus('b1', 'blue', 1, 2)],
    queue: ['red', 'blue', 'red', 'blue'],
  });
  const state = initializeLevel(level);
  enter(state, 'r1');
  enter(state, 'b1');
  const order = [];
  for (let i = 0; i < 4; i++) {
    const expected = state.queue[0];
    const ev = boardOnePassenger(state);
    check(`第 ${i + 1} 只上车的猫是队首 ${expected.id}`, ev?.passengerId === expected.id, JSON.stringify(ev));
    order.push(ev.passengerId);
    for (const d of departReady(state)) completeDeparture(state, d.busId);
  }
  check('上车顺序严格为 q0→q1→q2→q3', order.join(',') === 'q0,q1,q2,q3', order.join(','));
  check('红巴士载客 2/2 并完成', state.buses.r1.passengers === 2 && isCompleted(state.buses.r1));
  check('蓝巴士载客 2/2 并完成', state.buses.b1.passengers === 2 && isCompleted(state.buses.b1));
  assertInvariants('FIFO 结算后', state);
}

/* ================= 4. 阻挡不扣资源 / 不判负 ================= */
console.log('\n[4] 被阻挡车辆不消耗资源，不触发失败');
{
  const level = baseLevel({
    grid: { cols: 5, rows: 1 },
    buses: [rowBus('a', 'blue', 0, 2), rowBus('b', 'red', 0, 2, { x: 2 })],
    queue: ['blue', 'blue', 'red', 'red'],
  });
  const state = initializeLevel(level);
  const before = JSON.stringify(state);
  const res = validateMove(state, 'a');
  check('前方被挡时返回 blocked + 挡路车 id', !res.ok && res.reason === 'blocked' && res.blockerId === 'b', JSON.stringify(res));
  check('阻挡校验不修改任何状态', JSON.stringify(state) === before);
  check('操作数没有增加', state.moveCount === 0);
  check('不判负，仍可先移走挡路车', checkLose(state) === false && validateMove(state, 'b').ok);
  assertInvariants('阻挡后', state);
}

/* ================= 5. 增加临时停车位（每关 2 次） ================= */
console.log('\n[5] 增加临时停车位：每关 2 次，每次 +1，最多 +2');
{
  check('加位救援次数配置为 2', GAME_CONFIG.RESCUE_LIMIT === 2);
  check('额外车位上限为 2', MAX_EXTRA_SLOTS === 2 && GAME_CONFIG.EXTRA_SLOT_LIMIT === 2);

  const state = deadlockWithFourRedBuses();
  check('构造出真实的满位死局', checkLose(state) === true && state.status === 'lost');
  check('队首蓝色当前上不了车', queueHeadCanBoard(state) === false);
  const evalBefore = evaluateAddSlot(state, 2);
  check('失败局面评估：可以加位，且队首蓝车可驶出', evalBefore.ok && evalBefore.headAvailable === true, JSON.stringify(evalBefore));

  const queueLengthBefore = state.queue.length;
  const capBefore = Object.values(state.buses).map((b) => `${b.id}:${b.capacity}:${b.color}`).join('|');
  const res = addTemporarySlot(state, 2);
  check('加位成功且只扣 1 次', res.ok && res.slotLeft === 1, JSON.stringify(res));
  check('接客位从 4 变 5，且新位置标记为临时位', state.slots.length === 5 && state.slotCount === 5 && extraSlotCount(state) === 1);
  check('加位不增删猫咪、不改变车辆容量或颜色', state.queue.length === queueLengthBefore
    && Object.values(state.buses).map((b) => `${b.id}:${b.capacity}:${b.color}`).join('|') === capBefore);
  check('从失败状态加位后恢复 playing', state.status === 'playing');
  check('加位后死局解除（队首蓝车有位置可进）', checkLose(state) === false);
  check('蓝车可以进入新增的第 5 个接客位', enter(state, 'b1').ok && state.buses.b1.slotIndex === 4);
  settleAll(state);
  check('加位后蓝车接客并释放临时位', isCompleted(state.buses.b1) && state.slots[4].busId == null);
  check('红色巴士继续接客并完成本关', ['r1', 'r2', 'r3', 'r4'].every((id) => isCompleted(state.buses[id])) && checkWin(state));
  assertInvariants('加位闭环后', state);

  // 第二次加位 + 第三次被拒绝（预算/上限双重保护）
  const twoSlots = deadlockWithFourRedBuses();
  const r1 = addTemporarySlot(twoSlots, 2);
  const r2 = addTemporarySlot(twoSlots, r1.slotLeft);
  check('连续两次加位后共有 6 个接客位', r2.ok && twoSlots.slots.length === 6 && extraSlotCount(twoSlots) === 2);
  check('两次加位后剩余次数为 0', r2.slotLeft === 0);
  const beforeThird = JSON.stringify(twoSlots);
  const r3 = addTemporarySlot(twoSlots, 0);
  check('第三次加位被拒绝，不改变状态、次数不为负', !r3.ok && r3.reason === 'no-rescue-left'
    && r3.slotLeft === 0 && JSON.stringify(twoSlots) === beforeThird);

  // 即使传入更大的剩余次数，也不能突破 +2 上限。
  const limitState = deadlockWithFourRedBuses();
  addTemporarySlot(limitState, 9);
  addTemporarySlot(limitState, 8);
  const beforeLimit = JSON.stringify(limitState);
  const overLimit = addTemporarySlot(limitState, 7);
  check('临时车位达到 +2 后第三次被 slot-limit 拒绝', !overLimit.ok && overLimit.reason === 'slot-limit'
    && overLimit.slotLeft === 7 && JSON.stringify(limitState) === beforeLimit);

  // 新位置参与等待队列分配：4 个基础位已满时，第 5 辆车原先在等待；
  // 增加临时位并结算后应自动进场，而不是让位置空着。
  const waitingLevel = baseLevel({
    buses: [
      rowBus('r1', 'red', 0, 4), rowBus('r2', 'red', 1, 4),
      rowBus('r3', 'red', 2, 4), rowBus('r4', 'red', 3, 4),
      rowBus('b1', 'blue', 4, 2),
    ],
    queue: ['red', 'red', 'red', 'red', 'red', 'red', 'red', 'red',
      'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'blue', 'blue'],
  });
  const waiting = initializeLevel(waitingLevel);
  for (const id of ['r1', 'r2', 'r3', 'r4']) enter(waiting, id);
  check('4 个基础位已满，蓝车进入等待队列', moveBus(waiting, 'b1').queued === true && waiting.waiting[0] === 'b1');
  addTemporarySlot(waiting, 2);
  const dispatch = dispatchWaiting(waiting);
  check('新增临时位后等待车辆立即派入第 5 个位置', dispatch.length === 1
    && dispatch[0].busId === 'b1' && waiting.buses.b1.slotIndex === 4);
  assertInvariants('临时位派车后', waiting);

  // 旧的颜色队列调整保留为调试能力，但不再是正式救援入口。
  const legacy = deadlockWithFourRedBuses();
  const legacyTarget = findRescueTarget(legacy);
  const legacyRes = useRescue(legacy, 3);
  check('旧队列调整函数仍可独立工作（仅调试/历史能力）', legacyTarget?.color === 'red' && legacyRes.ok && !queueHeadCanBoard(legacy) === false);
}

/* ================= 6. 独立容量 / 上满即走 / 车位释放 ================= */
console.log('\n[6] 2/4/6 独立容量：单车满员立即离场，其他车继续接客');
{
  const level = baseLevel({
    grid: { cols: 8, rows: 4 },
    buses: [
      rowBus('r2', 'red', 0, 2),
      rowBus('b4', 'blue', 1, 4),
      rowBus('g6', 'green', 2, 6),
      rowBus('y4', 'yellow', 3, 4),
    ],
    queue: [
      'red', 'red',
      'blue', 'blue', 'blue', 'blue',
      'green', 'green', 'green', 'green', 'green', 'green',
      'yellow', 'yellow', 'yellow', 'yellow',
    ],
  });
  const state = initializeLevel(level);
  check('容量分别初始化为 2/4/6/4', ['r2', 'b4', 'g6', 'y4'].map((id) => state.buses[id].capacity).join('/') === '2/4/6/4');
  check('车身长度严格对应 2/3/4 格', ['r2', 'b4', 'g6', 'y4'].map((id) => state.buses[id].len).join('/') === '2/3/4/3');

  enter(state, 'r2');
  const ev1 = boardOnePassenger(state);
  check('红车第 1 只猫：计数 1/2', ev1?.busId === 'r2' && state.buses.r2.passengers === 1);
  const ev2 = boardOnePassenger(state);
  check('红车第 2 只猫：计数 2/2', ev2?.busId === 'r2' && state.buses.r2.passengers === 2);
  const d1 = departReady(state);
  check('红车达到 2/2 后立即离场', d1.length === 1 && d1[0].busId === 'r2' && isDeparting(state.buses.r2));
  check('离场瞬间接客位立刻释放', freeSlotCount(state) === SLOT_COUNT, `空位 ${freeSlotCount(state)}`);
  check('旧车动画结束前车位可被新车占用', enter(state, 'b4').ok);

  check('绿车、黄车也同时进场', enter(state, 'g6').ok && enter(state, 'y4').ok);
  check('3 辆不同容量车同时占位', freeSlotCount(state) === 1);
  const departures = [];
  for (;;) {
    const b = boardPassengers(state);
    const d = departReady(state);
    departures.push(...d);
    if (b.length === 0 && d.length === 0) break;
  }
  completeAllDepartures(state);
  check('蓝车按 4/4 完成', state.buses.b4.passengers === 4 && isCompleted(state.buses.b4));
  check('绿车按 6/6 完成', state.buses.g6.passengers === 6 && isCompleted(state.buses.g6));
  check('黄车按 4/4 完成', state.buses.y4.passengers === 4 && isCompleted(state.buses.y4));
  check('每辆车只产生一次离场事件', departures.length === 3 && new Set(departures.map((e) => e.busId)).size === 3);
  check('所有接客位最终释放', freeSlotCount(state) === SLOT_COUNT);
  check('本关可以通关', checkWin(state));
  assertInvariants('独立容量闭环后', state);
}

console.log('\n[7] 多辆车几乎同时满员：无重复离场 / 无车位泄漏');
{
  const colors = ['red', 'blue', 'green', 'purple'];
  const caps = [2, 4, 6, 4];
  const level = baseLevel({
    grid: { cols: 8, rows: 4 },
    buses: colors.map((c, i) => rowBus(`b${i}`, c, i, caps[i])),
    queue: colors.flatMap((c, i) => Array.from({ length: caps[i] }, () => c)),
  });
  const state = initializeLevel(level);
  for (let i = 0; i < 4; i++) check(`第 ${i + 1} 辆 2/4/6/4 容量车进场`, enter(state, `b${i}`).ok);
  const departures = [];
  const seen = new Set();
  let duplicate = false;
  for (;;) {
    const b = boardPassengers(state);
    const d = departReady(state);
    for (const ev of d) {
      if (seen.has(ev.busId)) duplicate = true;
      seen.add(ev.busId);
      departures.push(ev);
      completeDeparture(state, ev.busId);
    }
    if (b.length === 0 && d.length === 0) break;
  }
  check('4 辆车全部完成且各只一次', departures.length === 4 && !duplicate);
  check('每辆车载客数 = 自身容量', caps.every((cap, i) => state.buses[`b${i}`].passengers === cap));
  check('4 个接客位全部释放', freeSlotCount(state) === SLOT_COUNT);
  check('状态一致，无重复占用', validateStateInvariants(state).ok);
  check('通关', checkWin(state));
}

/* ================= 8. 同色先来后到 ================= */
console.log('\n[8] 同色车辆严格按进入接客位的 arrivalOrder 上客');
{
  const level = baseLevel({
    buses: [
      rowBus('b0', 'blue', 0, 2),
      rowBus('r1', 'red', 1, 2),
      rowBus('r2', 'red', 2, 2),
    ],
    queue: ['red', 'red', 'red', 'red'],
  });
  const state = initializeLevel(level);

  // 先让蓝车占住 0 号位；它没有同色猫，立即自动离场，释放 0 号位。
  enter(state, 'b0');
  for (const d of departReady(state)) completeDeparture(state, d.busId);
  enter(state, 'r1');
  const firstOrder = state.buses.r1.arrivalOrder;
  enter(state, 'r2');
  // 模拟「先到车停在右侧车位、后到车停在更靠左车位」：
  // 只交换接客位归属，不改变 arrivalOrder，验证优先级不依赖 slots 顺序。
  state.slots[1].busId = 'r1';
  state.slots[0].busId = 'r2';
  state.buses.r1.slotIndex = 1;
  state.buses.r2.slotIndex = 0;
  check('第二辆红车进入更靠左的 0 号位', state.buses.r2.slotIndex === 0 && state.buses.r1.slotIndex === 1);
  assertInvariants('交换车位后仍合法', state);
  check('第一辆红车的 arrivalOrder 更小', firstOrder < state.buses.r2.arrivalOrder, `${firstOrder} / ${state.buses.r2.arrivalOrder}`);

  const first = boardOnePassenger(state);
  const second = boardOnePassenger(state);
  check('红猫优先上第一辆红车（即使它在更右的车位）', first?.busId === 'r1' && second?.busId === 'r1', JSON.stringify([first, second]));
  check('第一辆未满时第二辆红车不能抢客', state.buses.r2.passengers === 0);
  for (const d of departReady(state)) completeDeparture(state, d.busId);
  check('第一辆满员后立即离场并释放车位', isCompleted(state.buses.r1) && state.buses.r1.slotIndex == null);
  const third = boardOnePassenger(state);
  const fourth = boardOnePassenger(state);
  check('第一辆离开后第二辆成为优先红车', third?.busId === 'r2' && fourth?.busId === 'r2', JSON.stringify([third, fourth]));
  for (const d of departReady(state)) completeDeparture(state, d.busId);
  check('两辆红车最终都按 2/2 完成', isCompleted(state.buses.r1) && isCompleted(state.buses.r2) && checkWin(state));
  assertInvariants('先来后到闭环后', state);
}

console.log('\n[9] 最早的同色车仍在 moving 时，后到车辆不能抢客');
{
  const level = baseLevel({
    buses: [rowBus('r1', 'red', 0, 2), rowBus('r2', 'red', 1, 2)],
    queue: ['red', 'red', 'red', 'red'],
  });
  const state = initializeLevel(level);
  moveBus(state, 'r1'); // moving，未到位
  moveBus(state, 'r2'); // moving
  completeArrival(state, 'r2'); // 只让后到的 r2 到位
  check('r1 仍在 moving，r2 已 loading', state.buses.r1.status === 'moving' && state.buses.r2.status === 'loading');
  check('r1 未到位时红猫不能上 r2', boardOnePassenger(state) === null);
  completeArrival(state, 'r1');
  const ev = boardOnePassenger(state);
  check('r1 到位后重新检查并优先上 r1', ev?.busId === 'r1', JSON.stringify(ev));
  assertInvariants('moving 阻塞后', state);
}

console.log('\n[10] 红车与蓝车同时接客：颜色不串线');
{
  const level = baseLevel({
    buses: [rowBus('r1', 'red', 0, 2), rowBus('b1', 'blue', 1, 2)],
    queue: ['red', 'blue', 'red', 'blue'],
  });
  const state = initializeLevel(level);
  enter(state, 'r1');
  enter(state, 'b1');
  const assignments = [];
  for (let i = 0; i < 4; i++) {
    const color = state.queue[0].color;
    const ev = boardOnePassenger(state);
    assignments.push({ cat: color, bus: ev?.busId, busColor: state.buses[ev?.busId]?.color });
    for (const d of departReady(state)) completeDeparture(state, d.busId);
  }
  check('每只猫都上同色车', assignments.every((a) => a.cat === a.busColor), JSON.stringify(assignments));
  check('红猫只上红车、蓝猫只上蓝车', assignments.every((a) => a.bus === (a.cat === 'red' ? 'r1' : 'b1')));
  assertInvariants('双色接客后', state);
}

/* ================= 11. 容量 / 车身 / 实际占用一致 ================= */
console.log('\n[11] 2/4/6 座车辆的容量、视觉长度、实际占用区域一致');
{
  check('容量映射表严格为 2→2 / 4→3 / 6→4',
    BUS_LENGTH_BY_CAPACITY[2] === 2 && BUS_LENGTH_BY_CAPACITY[4] === 3 && BUS_LENGTH_BY_CAPACITY[6] === 4);
  for (const cap of BUS_CAPACITIES) {
    const len = lengthForCapacity(cap);
    const bus = rowBus(`c${cap}`, 'red', 0, cap);
    const state = initializeLevel(baseLevel({ buses: [bus], queue: ['red'] }));
    const runtime = state.buses[`c${cap}`];
    check(`${cap} 座车 len=${len}`, runtime.len === len);
    check(`${cap} 座车实际占用 ${len} 格`, cellsOfBus(runtime).length === len);
    const svg = busSvgMarkup(runtime.len);
    check(`${cap} 座车视觉 viewBox 长度为 ${len * 100}`, svg.includes(`viewBox="0 0 ${len * 100} 100"`));
    const occ = buildOccupancy(state);
    check(`${cap} 座车占用表登记 ${len} 格`, cellsOfBus(runtime).every((c) => occ.get(`${c.x},${c.y}`) === runtime.id));
  }
}

/* ================= 12. 提速后连续上车仍然逐只正确 ================= */
console.log('\n[12] 上车提速 1.5 倍参数 + 连续 6 只猫逐只正确上车');
{
  check('上车速度倍率为 1.5（新时长 = 原时长 / 1.5）', GAME_CONFIG.BOARDING_SPEED === 1.5);
  const level = baseLevel({
    grid: { cols: 8, rows: 2 },
    buses: [rowBus('g6', 'green', 0, 6)],
    queue: ['green', 'green', 'green', 'green', 'green', 'green'],
  });
  const state = initializeLevel(level);
  enter(state, 'g6');
  const seen = new Set();
  for (let i = 1; i <= 6; i++) {
    const ev = boardOnePassenger(state);
    if (ev) seen.add(ev.passengerId);
    check(`第 ${i} 只绿猫计数 ${i}/6`, ev?.busId === 'g6' && state.buses.g6.passengers === i);
    if (i < 6) check(`第 ${i} 只后车仍未满`, state.buses.g6.passengers < state.buses.g6.capacity);
  }
  check('6 只猫没有重复上车', seen.size === 6 && state.queue.length === 0);
  check('达到 6/6 前不会提前离场', isCompleted(state.buses.g6) === false);
  const d = departReady(state);
  check('达到 6/6 后立即离场', d.length === 1 && isDeparting(state.buses.g6));
  check('离站动画未完成时不能提前判通关', checkWin(state) === false && state.status === 'playing');
  completeDeparture(state, d[0].busId);
  check('车辆 completed 且猫咪清空后才通关', checkWin(state) === true);
  assertInvariants('连续上车后', state);
}

/* ================= 13. 真死局 vs 暂时无空位 ================= */
console.log('\n[13] 真死局与「暂时满位 / 暂时没有匹配猫」正确区分');
{
  // 3 辆红车占位 + 1 个空位，队首蓝色，但蓝车可驶出 -> 只是暂时没匹配。
  const temporary = initializeLevel(baseLevel({
    buses: [
      rowBus('r1', 'red', 0, 4),
      rowBus('r2', 'red', 1, 4),
      rowBus('r3', 'red', 2, 4),
      rowBus('b1', 'blue', 3, 2),
    ],
    queue: ['blue', 'blue', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red'],
  }));
  for (const id of ['r1', 'r2', 'r3']) enter(temporary, id);
  check('暂时没有匹配猫 + 仍有空位/可驶出车：不判负', checkLose(temporary) === false && anyLegalMove(temporary));
  check('蓝车可以进场服务队首', enter(temporary, 'b1').ok && boardOnePassenger(temporary)?.busId === 'b1');

  // 4 辆红车占满，队首蓝色，蓝车无法进 -> 真死局。
  const dead = deadlockWithFourRedBuses();
  check('四格全满但红猫仍在后方：没有可发车车辆', hasReadyDeparture(dead) === false);
  check('四格全满 + 队首无法服务：判为真死局', checkLose(dead) === true && dead.status === 'lost');
  check('死局不依赖“四格全满”本身，而是无任何推进路径', freeSlotCount(dead) === 0 && !anyLegalMove(dead));

  // 有车辆 moving 时尚未稳定，不能提前判负。
  const pending = initializeLevel(baseLevel({
    buses: [rowBus('r1', 'red', 0, 4), rowBus('r2', 'red', 1, 4), rowBus('r3', 'red', 2, 4), rowBus('r4', 'red', 3, 4)],
    queue: ['blue', 'red', 'red', 'red', 'red'],
  }));
  for (const id of ['r1', 'r2', 'r3']) enter(pending, id);
  moveBus(pending, 'r4'); // moving，未到位
  check('有车辆 moving 时不判负', checkLose(pending) === false);
  completeAllArrivals(pending);
  check('全部到位且无推进路径后才判负', checkLose(pending) === true);

  // 四格全满但队首能上车时绝不判负。
  const boardable = deadlockWithFourRedBuses();
  boardable.queue.unshift({ id: 'head-red', color: 'red' });
  check('满位但队首可上车：不判负', checkLose(boardable) === false);
}

/* ================= 14. 后续车辆进入后队首被处理，原车继续 ================= */
console.log('\n[14] 等待车辆进入后处理队首，原有车辆继续上客');
{
  const level = baseLevel({
    buses: [
      rowBus('r1', 'red', 0, 4),
      rowBus('g1', 'green', 1, 2),
      rowBus('p1', 'purple', 2, 2),
      rowBus('y1', 'yellow', 3, 2),
      rowBus('b1', 'blue', 4, 2),
    ],
    queue: ['blue', 'blue', 'red', 'red', 'red', 'red'],
  });
  const state = initializeLevel(level);
  for (const id of ['r1', 'g1', 'p1', 'y1']) enter(state, id);
  check('四格已满，蓝车点击后进入等待队列', moveBus(state, 'b1').queued === true && state.waiting[0] === 'b1');
  const b1SlotBefore = state.buses.b1.slotIndex;
  check('等待中的蓝车没有提前占用接客位', b1SlotBefore == null);

  const events = settleAll(state);
  check('无同色猫的绿/紫/黄车自动离开释放车位', ['g1', 'p1', 'y1'].every((id) => isCompleted(state.buses[id])));
  check('蓝车在释放后进入并接走队首蓝猫', state.buses.b1.passengers === 2 && isCompleted(state.buses.b1));
  check('原有红车继续上客并完成', state.buses.r1.passengers === 4 && isCompleted(state.buses.r1));
  check('所有猫咪按 FIFO 运完', state.queue.length === 0 && checkWin(state));
  check('事件中蓝车有 dispatch', events.some((e) => e.type === 'dispatch' && e.busId === 'b1'));
  assertInvariants('等待车辆闭环后', state);
}

/* ================= 15. 快速连点 / 不重复占位 ================= */
console.log('\n[15] 快速连续点击多辆车：接客位、等待队列、猫咪数量始终一致');
{
  const specs = [
    ['b1', 'red', 0, 2],
    ['b2', 'blue', 1, 4],
    ['b3', 'green', 2, 6],
    ['b4', 'purple', 3, 2],
    ['b5', 'red', 4, 4],
    ['b6', 'blue', 5, 6],
    ['b7', 'green', 6, 2],
    ['b8', 'purple', 7, 4],
  ];
  const level = baseLevel({
    buses: specs.map(([id, color, row, cap]) => rowBus(id, color, row, cap)),
    queue: specs.flatMap(([, color, , cap]) => Array.from({ length: cap }, () => color)),
  });
  const state = initializeLevel(level);
  const catCount = state.queue.length;

  for (const [id] of specs) {
    const r = moveBus(state, id);
    if (!r.ok) check(`快速点击 ${id} 应成功`, false, JSON.stringify(r));
  }
  check('前 4 辆立即占位，后 4 辆进入等待队列',
    state.slots.every((s) => s.busId != null) && state.waiting.length === 4, state.waiting.join(','));
  check('等待顺序 = 点击顺序', state.waiting.join(',') === 'b5,b6,b7,b8');
  check('接客位所有者唯一', new Set(state.slots.map((s) => s.busId)).size === 4);
  check('等待车辆均无 slotIndex', state.waiting.every((id) => state.buses[id].slotIndex == null));
  check('每辆车只有一个状态，没有被重复派出', new Set(state.waiting.concat(state.slots.map((s) => s.busId))).size === 8);
  assertInvariants('快速连点中间态', state);

  const events = settleAll(state);
  const boardIds = events.filter((e) => e.type === 'board').map((e) => e.passengerId);
  check('8 辆车最终全部完成', specs.every(([id]) => isCompleted(state.buses[id])));
  check('所有猫恰好被接走一次', boardIds.length === catCount && new Set(boardIds).size === catCount);
  check('接客位最终清空', freeSlotCount(state) === SLOT_COUNT && state.waiting.length === 0);
  check('通关', checkWin(state));
  assertInvariants('快速连点闭环后', state);
}

/* ================= 16. 满员车辆不再接猫 ================= */
console.log('\n[16] 车辆满员后不会再次接收猫咪');
{
  const level = baseLevel({
    buses: [rowBus('r1', 'red', 0, 2), rowBus('r2', 'red', 1, 2)],
    queue: ['red', 'red', 'red', 'red'],
  });
  const state = initializeLevel(level);
  enter(state, 'r1');
  enter(state, 'r2');
  boardOnePassenger(state);
  boardOnePassenger(state);
  check('r1 达到 2/2 后计数不再增加', state.buses.r1.passengers === 2);
  const d = departReady(state);
  check('r1 满员后立即进入 departing，禁止继续上客', d.some((e) => e.busId === 'r1') && state.buses.r1.status === 'departing');
  const before = state.buses.r1.passengers;
  check('后续猫咪不会上已满员的 r1', boardOnePassenger(state)?.busId === 'r2' && state.buses.r1.passengers === before);
  completeDeparture(state, 'r1');
  check('动画结束后标 completed，且不再碰接客位', isCompleted(state.buses.r1) && state.buses.r1.slotIndex == null);
  check('completed 车辆不再占用接客位', state.slots.every((s) => s.busId !== 'r1'));
  assertInvariants('满员后', state);
}

/* ================= 17. 50 关完整性与参考解回放 ================= */
console.log('\n[17] 50 关数据 / 容量长度映射 / 参考解回放');
{
  check('共 50 关', LEVELS.length === 50, `实际 ${LEVELS.length}`);
  check('所有关卡统一 4 个接客位', LEVELS.every((lv) => lv.slots === SLOT_COUNT));
  check('第 10–50 关车辆数全部 >30', LEVELS.filter((lv) => lv.id >= 10).every((lv) => lv.buses.length > 30));
  check('第 10 关至少 31 辆', LEVELS.find((lv) => lv.id === 10)?.buses.length >= 31);
  check('第 50 关最多 60 辆', LEVELS.find((lv) => lv.id === 50)?.buses.length === 60);
  check('严格递增的后期车辆数下限', LEVELS.filter((lv) => lv.id >= 20).every((lv) => lv.buses.length >= 35)
    && LEVELS.filter((lv) => lv.id >= 30).every((lv) => lv.buses.length >= 44)
    && LEVELS.filter((lv) => lv.id >= 40).every((lv) => lv.buses.length >= 52));

  let replayOk = 0;
  let invariantOk = 0;
  let headOk = 0;
  let openingOk = 0;
  let capacityOk = 0;
  let capacityValid = 0;
  let capacityMixOk = 0;
  let lengthMatchOk = 0;
  let layoutOk = 0;
  const layoutKeys = new Set();
  for (const level of LEVELS) {
    const capByColor = new Map();
    for (const b of level.buses) capByColor.set(b.color, (capByColor.get(b.color) ?? 0) + b.capacity);
    const needByColor = new Map();
    for (const c of level.queue) needByColor.set(c, (needByColor.get(c) ?? 0) + 1);
    const colorOk = [...needByColor].every(([c, n]) => (capByColor.get(c) ?? 0) >= n);
    const capSum = level.buses.reduce((sum, b) => sum + b.capacity, 0);
    if (capSum === level.queue.length) capacityOk += 1;
    if (level.buses.every((b) => BUS_CAPACITIES.includes(b.capacity))) capacityValid += 1;
    if (level.buses.every((b) => b.len === lengthForCapacity(b.capacity))) lengthMatchOk += 1;
    if (level.id < 10 || new Set(level.buses.map((b) => b.capacity)).size === 3) capacityMixOk += 1;

    const rowFill = new Map();
    const colFill = new Map();
    for (const b of level.buses) {
      const horiz = b.dir === 'left' || b.dir === 'right';
      for (let i = 0; i < b.len; i++) {
        const x = horiz ? b.x + i : b.x;
        const y = horiz ? b.y : b.y + i;
        rowFill.set(y, (rowFill.get(y) ?? 0) + 1);
        colFill.set(x, (colFill.get(x) ?? 0) + 1);
      }
    }
    const noFullLine = [...rowFill.values()].every((n) => n < level.grid.cols)
      && [...colFill.values()].every((n) => n < level.grid.rows);
    const filled = new Set();
    for (const b of level.buses) {
      const horiz = b.dir === 'left' || b.dir === 'right';
      for (let i = 0; i < b.len; i++) filled.add(`${horiz ? b.x + i : b.x},${horiz ? b.y : b.y + i}`);
    }
    let longest = 0;
    for (let y = 0; y < level.grid.rows; y++) {
      let run = 0;
      for (let x = 0; x < level.grid.cols; x++) {
        run = filled.has(`${x},${y}`) ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
    }
    for (let x = 0; x < level.grid.cols; x++) {
      let run = 0;
      for (let y = 0; y < level.grid.rows; y++) {
        run = filled.has(`${x},${y}`) ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
    }
    if (noFullLine && longest <= Math.ceil(level.grid.cols * 0.72)) layoutOk += 1;

    const initial = initializeLevel(level);
    const legal = Object.values(initial.buses).filter((b) => validateMove(initial, b.id).ok);
    if (legal.some((b) => b.color === level.queue[0])) headOk += 1;
    if (level.id < 10 || legal.length >= Math.max(4, Math.ceil(level.buses.length * 0.06))) openingOk += 1;

    const layoutKey = level.buses
      .map((b) => `${b.dir}:${b.x},${b.y},${b.len}`)
      .sort()
      .join('|');
    layoutKeys.add(layoutKey);

    const state = initializeLevel(level);
    settleAll(state);
    let ok = colorOk && validateStateInvariants(state).ok;
    for (const busId of level.solution.moves) {
      const move = moveBus(state, busId);
      if (!move.ok) { ok = false; break; }
      settleAll(state);
      if (!validateStateInvariants(state).ok) { ok = false; break; }
      if (state.status === 'lost') { ok = false; break; }
    }
    if (ok && checkWin(state)) replayOk += 1;
    if (validateStateInvariants(state).ok) invariantOk += 1;
  }
  check('全部 50 关参考解真实回放通关', replayOk === 50, `通过 ${replayOk}/50`);
  check('全部 50 关回放后状态一致', invariantOk === 50, `一致 ${invariantOk}/50`);
  check('全部关卡开局都有「队首同色且可驶出」的车', headOk === 50, `满足 ${headOk}/50`);
  check('第 10 关起开局可动车辆数达到下限', openingOk === 50, `满足 ${openingOk}/50`);
  check('全部关卡队列长度 = 车辆总容量', capacityOk === 50, `满足 ${capacityOk}/50`);
  check('全部巴士容量都是 2/4/6', capacityValid === 50, `满足 ${capacityValid}/50`);
  check('全部巴士容量与车身长度严格对应', lengthMatchOk === 50, `满足 ${lengthMatchOk}/50`);
  check('第 10 关起每关都混用 2/4/6 三种容量', capacityMixOk === 50, `满足 ${capacityMixOk}/50`);
  check('没有整行/整列占满，也没有超长连续车墙', layoutOk === 50, `满足 ${layoutOk}/50`);
  check('50 关布局互不重复', layoutKeys.size === 50, `唯一布局 ${layoutKeys.size}/50`);
}

/* ================= 18. 重开 / 撤回 / 提示 ================= */
console.log('\n[18] 反复重开、历史快照、智能提示不会损坏状态');
{
  const level = LEVELS.find((lv) => lv.id === 50);
  check('第 50 关保留关卡元数据提示', typeof level.hint === 'string' && level.hint.length > 0);
  for (let i = 0; i < 20; i++) {
    const s = initializeLevel(level);
    const v = validateStateInvariants(s);
    if (!v.ok) { check(`第 ${i + 1} 次重开状态一致`, false, v.errors.join('; ')); break; }
    if (i === 19) check('连续重开 20 次状态一致', true);
  }

  const state = initializeLevel(level);
  const snapshots = [];
  const moves = level.solution.moves;
  for (let i = 0; i < 12; i++) {
    snapshots.push(structuredClone(state));
    moveBus(state, moves[i]);
    settleAll(state);
  }
  assertInvariants('推进 12 步后', state);

  const restored = snapshots[6];
  const hintBefore = JSON.stringify(restored);
  const smartHint = buildSmartHint(restored, { rescueLeft: 2 });
  check('读取智能提示不改变 state', JSON.stringify(restored) === hintBefore
    && typeof smartHint.text === 'string' && smartHint.text.length > 0);
  check('智能提示引用真实队首颜色', smartHint.text.includes(
    { red: '红色', blue: '蓝色', green: '绿色', purple: '紫色', cyan: '青色', orange: '橙色', yellow: '黄色' }[restored.queue[0].color] || ''
  ));
  settleAll(restored);
  assertInvariants('撤回快照重放后', restored);

  let ok = true;
  for (const busId of moves.slice(6)) {
    if (!moveBus(restored, busId).ok) { ok = false; break; }
    settleAll(restored);
    if (!validateStateInvariants(restored).ok || restored.status === 'lost') { ok = false; break; }
  }
  check('撤回后从第 7 步继续仍能通关', ok && checkWin(restored));

  const corrupt = structuredClone(initializeLevel(level));
  corrupt.slots[0].busId = corrupt.slots[1].busId = Object.keys(corrupt.buses)[0];
  check('自检能发现重复占用接客位', validateStateInvariants(corrupt).ok === false);
}

/* ================= 19. 智能提示：基于真实局面 ================= */
console.log('\n[19] 智能提示覆盖满位 / 同色先来后到 / 容量 / 救援 / 风险');
{
  const full = deadlockWithFourRedBuses();
  const hintA = buildSmartHint(full, { rescueLeft: 2 });
  check('A. 四格占满且队首蓝猫无车可上：提示具体指出加位', hintA.kind === 'need-slot'
    && hintA.text.includes('蓝色') && hintA.text.includes('加位') && hintA.text.includes('2 次'), hintA.text);
  check('A. 提示不引用不存在的车辆', !hintA.busId || !!full.buses[hintA.busId]);

  const noAdd = buildSmartHint(full, { rescueLeft: 0 });
  check('E. 加位次数为 0 时明确说明无法救援', noAdd.kind === 'full' && noAdd.text.includes('用完'), noAdd.text);
  check('E. describeAddSlot 明确说明次数原因', describeAddSlot(full, 0).text.includes('次数'), describeAddSlot(full, 0).text);

  const fifoLevel = baseLevel({
    grid: { cols: 7, rows: 3 },
    buses: [rowBus('r1', 'red', 0, 4), rowBus('r2', 'red', 1, 4)],
    queue: ['red', 'red', 'red', 'red', 'red', 'red', 'red', 'red'],
  });
  const fifoState = initializeLevel(fifoLevel);
  enter(fifoState, 'r1');
  enter(fifoState, 'r2');
  const hintB = buildSmartHint(fifoState, { rescueLeft: 2 });
  check('B. 同色多车按 arrivalOrder 给出第一辆建议', hintB.kind === 'fifo'
    && hintB.busId === 'r1' && hintB.text.includes('第 1 辆') && hintB.text.includes('第 2 辆'), hintB.text);

  const capLevel = baseLevel({
    grid: { cols: 8, rows: 2 },
    buses: [rowBus('g6', 'green', 0, 6)],
    queue: ['green', 'green', 'green', 'green', 'green', 'red', 'green', 'green', 'green', 'green', 'green'],
  });
  const capState = initializeLevel(capLevel);
  enter(capState, 'g6');
  boardOnePassenger(capState); // 队首仍为绿色，巴士 1/6，后面隔着一只红猫还有绿猫
  const hintC = buildSmartHint(capState, { rescueLeft: 2 });
  check('C. 容量提示按真实队首连续数量计算', hintC.kind === 'capacity'
    && hintC.text.includes('还差 5 只') && hintC.text.includes('4 只'), hintC.text);
  check('C. 提示引用的巴士真实存在且仍在接客位', !!capState.buses[hintC.busId]
    && capState.buses[hintC.busId].slotIndex != null);

  // 队首同色车被挡：提示应指向真实挡路车。
  const blockedLevel = baseLevel({
    grid: { cols: 6, rows: 2 },
    buses: [
      { id: 'redBlocked', color: 'red', len: 2, dir: 'right', x: 0, y: 0, capacity: 2 },
      { id: 'greenBlocker', color: 'green', len: 2, dir: 'right', x: 2, y: 0, capacity: 2 },
      { id: 'blueOther', color: 'blue', len: 2, dir: 'right', x: 0, y: 1, capacity: 2 },
    ],
    queue: ['red', 'red', 'green', 'green', 'blue', 'blue'],
  });
  const blockedState = initializeLevel(blockedLevel);
  const hintBlocked = buildSmartHint(blockedState, { rescueLeft: 2 });
  check('D. 队首同色被挡时指向真实挡路车', hintBlocked.kind === 'unblock'
    && hintBlocked.busId === 'greenBlocker' && hintBlocked.text.includes('绿色'), hintBlocked.text);

  // 可证明的死局操作：当前仍可解，但移动绿色车会占满最后一位并直接堵死。
  const riskLevel = baseLevel({
    grid: { cols: 8, rows: 6 },
    buses: [
      rowBus('rr1', 'red', 0, 4), rowBus('rr2', 'red', 1, 4), rowBus('rr3', 'red', 2, 4),
      rowBus('gg1', 'green', 3, 2), rowBus('bb1', 'blue', 4, 4),
    ],
    queue: [
      'blue', 'blue', 'blue', 'blue',
      'green', 'green',
      'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red',
    ],
  });
  const riskState = initializeLevel(riskLevel);
  for (const id of ['rr1', 'rr2', 'rr3']) enter(riskState, id);
  const riskBefore = JSON.stringify(riskState);
  const risk = evaluateMoveRisk(riskState, 'gg1');
  const riskText = describeMoveRisk(riskState, 'gg1', risk);
  check('F. 可证明会失去所有通关路径的操作被识别为 proven', risk.level === 'proven', JSON.stringify(risk.level));
  check('F. 风险文案使用确定语气并引用队首蓝猫', riskText.includes('会') && riskText.includes('蓝色'), riskText);
  check('F. 风险分析不修改当前局面', JSON.stringify(riskState) === riskBefore);
  const safeRisk = evaluateMoveRisk(riskState, 'bb1');
  check('F. 仍然可通关的操作不会被误报为死局', safeRisk.level === 'safe', JSON.stringify(safeRisk.level));

  const beforeHints = JSON.stringify(full);
  const hintAgain = buildSmartHint(full, { rescueLeft: 2 });
  check('同一状态两次提示完全一致（便于去重）', hintAgain.key === hintA.key && hintAgain.text === hintA.text);
  check('提示函数不修改 state', JSON.stringify(full) === beforeHints);
}

/* ================= 20. 多解法 / 可解性搜索指标 ================= */
console.log('\n[20] 多解法搜索：至少两条真实不同开局路径，且每条都回放通关');
{
  const replay = (level, path) => {
    const s = initializeLevel(level);
    settleAll(s);
    for (const busId of path) {
      const r = moveBus(s, busId);
      if (!r.ok) return false;
      settleAll(s);
      if (s.status === 'lost') return false;
    }
    return checkWin(s);
  };
  for (const id of [1, 5, 10, 30, 50]) {
    const level = LEVELS.find((lv) => lv.id === id);
    const m = analyzeLevel(level, { branchNodes: 1500, criticalDepth: 1, maxSolutions: 3 });
    check(`第 ${id} 关：搜索判定可解且未超预算`, m.solvable && !m.aborted, JSON.stringify({
      solvable: m.solvable, aborted: m.aborted, nodes: m.nodes,
    }));
    check(`第 ${id} 关：找到至少 2 条不同开局解`, m.solutionCount >= 2 && m.samplePaths.length >= 2,
      `${m.solutionCount}/${m.openingLegal}`);
    const keys = new Set(m.samplePaths.map((p) => p.join(',')));
    check(`第 ${id} 关：样本路径决策序列不重复`, keys.size === m.samplePaths.length);
    check(`第 ${id} 关：每条样本路径都能真实通关`, m.samplePaths.every((p) => replay(level, p)));
    check(`第 ${id} 关：分支数指标为真实正数`, m.minBranching >= 1 && m.maxBranching >= m.minBranching);
  }

  const level50 = LEVELS.find((lv) => lv.id === 50);
  const one = findPath(initializeLevel(level50), {
    maxNodes: 3000,
    preferred: level50.solution.moves,
  });
  check('第 50 关：有界 DFS 能沿参考顺序找到完整路径',
    one.solvable && !one.aborted && one.path.length === level50.buses.length,
    `${one.path?.length ?? 0} 步 / ${one.nodes} 节点`);
}

/* ================= 21. 临时位状态一致性 ================= */
console.log('\n[21] 临时停车位状态自检');
{
  const s = deadlockWithFourRedBuses();
  addTemporarySlot(s, 2);
  addTemporarySlot(s, 1);
  const v = validateStateInvariants(s);
  check('6 个接客位（4 基础 + 2 临时）状态一致', v.ok, v.errors.join('; '));
  const bad = structuredClone(s);
  bad.slots[4].extra = false;
  check('自检能发现临时位标记错误', validateStateInvariants(bad).ok === false);
  const tooMany = structuredClone(s);
  tooMany.slots.push({ index: 6, busId: null, extra: true });
  check('自检能发现超过 +2 临时位上限', validateStateInvariants(tooMany).ok === false);
  const mismatch = structuredClone(s);
  mismatch.slotCount = 4;
  check('自检能发现 slotCount 与实际接客位不一致', validateStateInvariants(mismatch).ok === false);
}

/* ================= 汇总 ================= */
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部规则层验收测试通过 ✅');
}