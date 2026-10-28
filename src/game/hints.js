/**
 * 智能提示：根据当前真实局面生成「下一 actions」建议
 * ------------------------------------------------------------
 * 设计原则：
 *  - 只读取 state，不修改任何游戏数据；
 *  - 所有车辆、颜色、容量、车位数量都来自 state，不写死关卡文案；
 *  - 先给可立即执行的动作，再给一句原因；
 *  - 搜索器无法证明时明确说「无法确定」，不编造必胜建议；
 *  - 同色巴士严格遵守 arrivalOrder 先来后到；容量 2/4/6 与
 *    基础 4 个接客位 + 最多 2 个临时位都按真实规则计算。
 * ------------------------------------------------------------
 */
import {
  buildOccupancy,
  earliestSlotBusOfColor,
  evaluateAddSlot,
  exitPathOfBus,
  extraSlotCount,
  freeSlotCount,
  pathIsClear,
  validateMove,
  MAX_EXTRA_SLOTS,
} from './logic.js';

export const COLOR_NAMES = {
  red: '红色', blue: '蓝色', green: '绿色', purple: '紫色',
  cyan: '青色', orange: '橙色', yellow: '黄色',
};

const cn = (color) => COLOR_NAMES[color] || color || '这辆';

/** 队列从队首开始连续同色的猫咪数量（只有这些猫现在/最近能连续上车）。 */
function consecutiveColorCount(queue, color) {
  let n = 0;
  for (const p of queue) {
    if (p.color !== color) break;
    n += 1;
  }
  return n;
}

/** 接客位里仍在接客/驶入的车辆（不含 waiting / departing）。 */
function slotBuses(state) {
  const out = [];
  for (const slot of state.slots) {
    if (slot.busId == null) continue;
    const bus = state.buses[slot.busId];
    if (!bus) continue;
    if (bus.status !== 'loading' && bus.status !== 'moving') continue;
    out.push({ bus, slot });
  }
  return out;
}

/** 影响某辆棋盘车的挡路车（第一层）。 */
function blockersOf(state, busId) {
  const bus = state.buses[busId];
  if (!bus || bus.status !== 'board') return [];
  const occ = buildOccupancy(state);
  const out = [];
  for (const c of exitPathOfBus(bus, state.grid)) {
    const id = occ.get(`${c.x},${c.y}`);
    if (id && id !== busId) out.push(id);
  }
  return out;
}

/** 从一辆被挡车出发，沿阻挡链找到第一辆真正能驶出的车。 */
function firstMovableBlocker(state, busId) {
  const seen = new Set();
  const queue = blockersOf(state, busId);
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const bus = state.buses[id];
    if (!bus || bus.status !== 'board') continue;
    if (validateMove(state, id).ok) return bus;
    queue.push(...blockersOf(state, id));
  }
  return null;
}

function headColor(state) {
  return state.queue[0]?.color ?? null;
}

function legalHeadBuses(state) {
  const color = headColor(state);
  if (!color) return [];
  return Object.values(state.buses).filter(
    (b) => b.status === 'board' && b.color === color && validateMove(state, b.id).ok
  );
}

/**
 * 生成当前局面的操作建议。
 * @param {object} state
 * @param {{ rescueLeft?: number, risk?: object }} options
 * @returns {{ key: string, text: string, busId?: string, color?: string, kind: string, actionable: boolean }}
 */
export function buildSmartHint(state, options = {}) {
  const rescueLeft = Math.max(0, options.rescueLeft ?? 0);
  if (!state) {
    return {
      key: 'no-state',
      text: '关卡还没有加载完成，请稍候。',
      kind: 'info',
      actionable: false,
    };
  }
  if (state.status === 'won') {
    return {
      key: 'won',
      text: '所有猫咪都上车了，这一关已经完成。可以进入下一关，或再玩一次挑战更少步数。',
      kind: 'won',
      actionable: false,
    };
  }

  const head = headColor(state);
  const headLabel = head ? `${cn(head)}猫` : '队首猫咪';
  const free = freeSlotCount(state);
  const slots = slotBuses(state);
  const extra = extraSlotCount(state);
  const addEval = evaluateAddSlot(state, rescueLeft);

  if (state.status === 'lost') {
    const canAdd = addEval.ok && addEval.headAvailable;
    return {
      key: 'lost',
      text: canAdd
        ? `已经堵死了：接客位被占满，队首${headLabel}进不了场。使用「加位」可以多 1 个接客位，让可驶出的${cn(head)}巴士进场（还剩 ${rescueLeft} 次）。`
        : `已经堵死了：接客位无法腾出，队首${headLabel}也上不了任何车。${
          addEval.ok ? '加位也帮不上忙——' : '加位暂时无法使用——'
        }${addReasonText(addEval)}建议「重开本关」。`,
      kind: 'lost',
      actionable: canAdd,
    };
  }

  // 正在驶入的车辆：先说明它尚未到位，避免玩家误以为可以立刻上车。
  const moving = slots.find(({ bus }) => bus.status === 'moving');
  if (moving) {
    return {
      key: `moving-${moving.bus.id}`,
      text: `${cn(moving.bus.color)}巴士正在驶入接客位，到位后才会开始接客。先不用重复点它；可以继续观察队首${headLabel}，或安排下一辆可驶出的车。`,
      busId: moving.bus.id,
      color: moving.bus.color,
      kind: 'moving',
      actionable: false,
    };
  }

  /* ---------- 情况 B：同色车辆有多辆，先来后到 ---------- */
  if (head) {
    const sameColorBuses = slots
      .filter(({ bus }) => bus.color === head && bus.status === 'loading')
      .sort((a, b) => (a.bus.arrivalOrder ?? 0) - (b.bus.arrivalOrder ?? 0));
    if (sameColorBuses.length >= 2) {
      const first = sameColorBuses[0].bus;
      const second = sameColorBuses[1].bus;
      const needFirst = first.capacity - first.passengers;
      const needSecond = second.capacity - second.passengers;
      return {
        key: `fifo-${head}-${first.id}-${first.passengers}`,
        text: `接客位里有 ${sameColorBuses.length} 辆${cn(head)}巴士。按进入接客位的先后，先让第 1 辆（还差 ${needFirst} 只）接满离站，第 2 辆（还差 ${needSecond} 只）才能抢到${cn(head)}猫；不要先指望后面的车。`,
        busId: first.id,
        color: head,
        kind: 'fifo',
        actionable: true,
      };
    }
  }

  /* ---------- 情况 C / 队首可上车：容量与真实队列顺序 ---------- */
  if (head) {
    const earliest = earliestSlotBusOfColor(state, head);
    if (earliest && earliest.status === 'loading' && earliest.passengers < earliest.capacity) {
      const need = earliest.capacity - earliest.passengers;
      const run = consecutiveColorCount(state.queue, head);
      const laterSame = state.queue.slice(run).filter((p) => p.color === head).length;
      if (run >= need) {
        return {
          key: `board-${earliest.id}-${earliest.passengers}`,
          text: `队首连续有 ${run} 只${cn(head)}猫，接客位上的${cn(head)}巴士还差 ${need} 只满员；让它继续接客即可，满员后会立刻离站腾出位置。`,
          busId: earliest.id,
          color: head,
          kind: 'board',
          actionable: true,
        };
      }
      if (laterSame > 0) {
        return {
          key: `board-short-${earliest.id}-${earliest.passengers}`,
          text: `队首只有 ${run} 只${cn(head)}猫能马上上车，这辆${cn(head)}巴士还差 ${need} 只才满员。先接完这 ${run} 只，再安排另一辆${cn(head)}巴士接力，不要提前把车位停满。`,
          busId: earliest.id,
          color: head,
          kind: 'capacity',
          actionable: true,
        };
      }
      return {
        key: `board-last-${earliest.id}-${earliest.passengers}`,
        text: `队首的${cn(head)}猫可以上接客位里的${cn(head)}巴士（当前 ${earliest.passengers}/${earliest.capacity}）。接完这一批后该颜色就清空了，巴士会自动离站。`,
        busId: earliest.id,
        color: head,
        kind: 'board',
        actionable: true,
      };
    }
  }

  /* ---------- 情况 A：接客位全部占满 ---------- */
  if (free === 0) {
    const releasing = slots
      .filter(({ bus }) => bus.status === 'loading' && state.queue.some((p) => p.color === bus.color))
      .sort((a, b) => (a.bus.capacity - a.bus.passengers) - (b.bus.capacity - b.bus.passengers));
    const candidate = releasing[0]?.bus;
    const headLegal = legalHeadBuses(state);
    const canAdd = addEval.ok && addEval.headAvailable;
    const waiting = state.waiting.length;

    if (canAdd) {
      const releaseText = candidate
        ? `接客位上的${cn(candidate.color)}巴士还差 ${candidate.capacity - candidate.passengers} 只满员，但它要等同色猫排到队首。`
        : '';
      return {
        key: `full-add-${head}-${rescueLeft}-${extra}`,
        text: `接客位已满${waiting ? `（另有 ${waiting} 辆在等待）` : ''}，队首${headLabel}暂时没有可上的车。${releaseText}使用「加位」可以临时多容纳 1 辆，让停车场里可驶出的${cn(head)}巴士进场接客（还剩 ${rescueLeft} 次）。`,
        color: head,
        kind: 'need-slot',
        actionable: true,
      };
    }
    if (candidate) {
      return {
        key: `full-wait-${candidate.id}`,
        text: `接客位已满${waiting ? `（另有 ${waiting} 辆等待）` : ''}。${cn(candidate.color)}巴士还差 ${candidate.capacity - candidate.passengers} 只满员，但它要等同色猫排到队首；当前队首是${headLabel}。${
          addReasonText(addEval) || '先把能服务队首的车找出来，必要时再考虑重开。'
        }`,
        busId: candidate.id,
        color: candidate.color,
        kind: 'full',
        actionable: false,
      };
    }
    return {
      key: `full-stuck-${head}-${extra}`,
      text: `接客位已满，队首${headLabel}上不了任何车。${
        headLegal.length > 0
          ? `停车场里有可驶出的${cn(head)}巴士，但需要先腾出一个接客位。`
          : '停车场里也没有可驶出的同色巴士。'
      }${addEval.ok ? addReasonText(addEval) : '加位暂时用不上，建议「重开本关」。'}`,
      color: head,
      kind: 'full',
      actionable: false,
    };
  }

  /* ---------- 队首同色的车可驶出：直接给下一步 ---------- */
  if (head) {
    const legal = legalHeadBuses(state);
    if (legal.length > 0) {
      const bus = legal[0];
      const slotHint = free === 1 ? '这是最后一个空位，进去后要尽快让它接满。' : `接客位还有 ${free} 个空位。`;
      return {
        key: `move-head-${bus.id}-${free}`,
        text: `队首是${headLabel}，停车场里的${cn(bus.color)}巴士（${bus.id}）现在可以驶出。先点它进场，${slotHint}`,
        busId: bus.id,
        color: bus.color,
        kind: 'move',
        actionable: true,
      };
    }

    // 队首同色的车被挡住：沿阻挡链找到第一辆能动的车。
    const headBuses = Object.values(state.buses).filter(
      (b) => b.status === 'board' && b.color === head
    );
    if (headBuses.length > 0) {
      for (const bus of headBuses) {
        const check = validateMove(state, bus.id);
        if (!check.ok && check.reason === 'blocked') {
          const blocker = firstMovableBlocker(state, bus.id);
          if (blocker) {
            return {
              key: `unblock-${bus.id}-${blocker.id}`,
              text: `队首是${headLabel}，但${cn(bus.color)}巴士被${cn(blocker.color)}巴士（${blocker.id}）挡住了。先移走${cn(blocker.color)}巴士，沿着这条阻挡链把${cn(head)}巴士放出来。`,
              busId: blocker.id,
              color: blocker.color,
              kind: 'unblock',
              actionable: true,
            };
          }
        }
      }
    }
  }

  /* ---------- 没有队首色可动：先移开挡路车 / 利用等待队列 ---------- */
  const occ = buildOccupancy(state);
  const legalAny = Object.values(state.buses).filter(
    (b) => b.status === 'board' && pathIsClear(b, state, occ)
  );
  if (legalAny.length > 0) {
    // 优先选择能间接帮到队首色的车：它挡住的路径上是否有队首色车。
    const useful = legalAny.find((b) => {
      const before = blockersOf(state, b.id);
      return before.length === 0 && Object.values(state.buses).some(
        (target) => target.status === 'board' && target.color === head && validateMove(state, target.id).blockerId === b.id
      );
    }) ?? legalAny[0];
    const queueHasColor = state.queue.some((p) => p.color === useful.color);
    return {
      key: `open-${useful.id}-${free}`,
      text: `队首是${headLabel}，但现在没有可驶出的${cn(head)}巴士。先把可驶出的${cn(useful.color)}巴士（${useful.id}）移进接客位${
        queueHasColor ? `，它还能顺路接${cn(useful.color)}猫` : ''
      }；腾出棋盘通道后，${cn(head)}巴士才有机会出来。`,
      busId: useful.id,
      color: useful.color,
      kind: 'open',
      actionable: true,
    };
  }

  if (state.waiting.length > 0) {
    return {
      key: `waiting-${state.waiting.length}`,
      text: `还有 ${state.waiting.length} 辆巴士在等待接客位。当前没有可驶出的车辆，先让接客位里的巴士继续接客/离站，等待车辆会在空位出现后自动进场。`,
      kind: 'waiting',
      actionable: false,
    };
  }

  /* ---------- 兜底：给确定可执行的建议或如实说明 ---------- */
  if (rescueLeft > 0) {
    return {
      key: `no-move-${head}-${rescueLeft}`,
      text: `当前没有可驶出的巴士，队首${headLabel}也上不了车。${
        addEval.ok ? addReasonText(addEval) : '加位也无法解决，建议「重开本关」。'
      }`,
      kind: 'stuck',
      actionable: addEval.ok,
    };
  }
  return {
    key: `no-move-${head}-0`,
    text: `当前没有可驶出的巴士，队首${headLabel}也上不了车，且本关的加位次数已经用完。建议「重开本关」换一个顺序。`,
    kind: 'stuck',
    actionable: false,
  };
}

/** 解释「加位为什么现在帮不上/收益不高」，供提示与确认框共用。 */
export function addReasonText(evalResult = {}) {
  switch (evalResult.reason) {
    case 'already-won':
      return '本关已经完成，不需要再加位。';
    case 'no-rescue-left':
      return '本关的加位次数已经用完了。';
    case 'slot-limit':
      return `临时车位已经达到上限（最多额外 ${MAX_EXTRA_SLOTS} 个）。`;
    case 'queue-empty':
      return '猫咪队列已经清空，不需要再加位。';
    case 'no-exit-bus':
      return '停车场里没有可驶出的巴士，新增车位也无法被使用。';
    case 'has-free-slot':
      return `现在还有 ${evalResult.freeSlots} 个空接客位，先安排可驶出的车更划算。`;
    case 'busy':
      return '车辆正在移动/结算，等稳定后再加位。';
    default:
      return '';
  }
}

/**
 * 加位建议（失败覆盖层 / HUD 提示）。
 * 返回 { usable, text }。
 */
export function describeAddSlot(state, rescueLeft) {
  const r = evaluateAddSlot(state, rescueLeft);
  if (!r.ok) return { usable: false, text: addReasonText(r) || '当前无法增加停车位。' };
  if (r.reason === 'has-free-slot') {
    return {
      usable: true,
      text: `还有 ${r.freeSlots} 个空接客位，暂时不是必须加位；如果担心后面堵住，也可以提前增加 1 个（还剩 ${rescueLeft} 次）。`,
    };
  }
  if (r.headAvailable) {
    return {
      usable: true,
      text: `接客位已满，加位后停车场里可驶出的${cn(state.queue[0]?.color)}巴士可以立刻进场服务队首（还剩 ${rescueLeft} 次）。`,
    };
  }
  return {
    usable: false,
    text: `接客位已满，但停车场里没有可驶出的队首同色巴士；加位只能多一个空位，暂时无法让队首猫上车。`,
  };
}

/**
 * 把搜索器的风险结论翻译成玩家看得懂的提醒。
 * 只有 proven 才使用确定语气；unknown 一律使用「可能/无法确定」。
 */
export function describeMoveRisk(state, busId, risk) {
  const bus = state?.buses?.[busId];
  if (!bus || !risk) return '';
  const head = headColor(state);
  const headLabel = head ? `${cn(head)}猫` : '队首猫';
  const slotSummary = slotBuses(state)
    .map(({ bus: b }) => `${cn(b.color)}（还差 ${b.capacity - b.passengers} 只）`)
    .slice(0, 4)
    .join('、');

  if (risk.level === 'proven') {
    if (risk.reason === 'immediate-lost') {
      return `注意：${cn(bus.color)}巴士进入后会占满最后一个接客位，而${headLabel}没有可上的车，下一步会直接堵死。建议先让接客位上的${slotSummary || '车辆'}接满腾位。`;
    }
    return `注意：这一步之后会失去所有通关路线。建议先处理队首${headLabel}，或让接客位上的${slotSummary || '车辆'}先接满离站。`;
  }
  if (risk.level === 'unknown') {
    return `这一步的结果在当前搜索预算内无法确定，可能会堵死。建议谨慎：先让接客位上的${slotSummary || '车辆'}接满，或优先服务队首${headLabel}。`;
  }
  return '';
}