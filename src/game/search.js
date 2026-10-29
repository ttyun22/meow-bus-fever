/**
 * 关卡搜索 / 解法多样性分析（浏览器与 Node 共用）
 * ------------------------------------------------------------
 * 本模块只读 state（通过 structuredClone 模拟），不会修改调用方的
 * 游戏状态；求解、提示风险分析、生成器验证与 CLI 验证共用同一套
 * logic.js 规则，避免「验证规则」和「实际规则」漂移。
 *
 * 重要术语：
 *  - 一个「解法」= 一串真正不同的玩家决策（点击哪一辆车），而不是
 *    动画顺序 / 结算顺序；同一串车辆 id 只计一次。
 *  - openingWins / solutionCount = 统计「不同开局决策中，能够找到
 *    完整通关路径的数量」。每条路径都由 logic.js 逐步回放并真实到达
 *    won，因此是真实解法，不是启发式猜测。
 *  - 搜索有节点预算；预算耗尽时返回 aborted=true，调用方必须把它
 *    标成「未知」，不能当成「无解」。
 * ------------------------------------------------------------
 */
import {
  initializeLevel,
  validateMove,
  moveBus,
  settleAll,
  checkWin,
  checkLose,
} from './logic.js';

export const SEARCH_LIMITS = Object.freeze({
  /** 单个分支最多展开多少个去重后的局面（够覆盖 31–60 辆关卡的多条路线）。 */
  MAX_NODES: 120_000,
  /** 一次分析最多收集多少条完整路径（每条路径都真实回放通关）。 */
  MAX_SOLUTIONS: 6,
  /** 开局分支搜索的预算（每个开局决策单独计算，互不抢占）。 */
  BRANCH_NODES: 45_000,
  /** 风险提示的搜索预算：宁可返回「无法确定」，也不编造。 */
  RISK_NODES: 25_000,
  /** 高密度关卡只对前 N 步做「关键决策」检测，避免无上限搜索。 */
  CRITICAL_DEPTH: 12,
});

const STATUS_CODE = Object.freeze({
  board: 'b',
  waiting: 'w',
  moving: 'm',
  loading: 'l',
  departing: 'd',
  completed: 'c',
});

/** 局面去重键：包含车辆状态、车位绑定、载客数、队列、等待队列。 */
export function stateKey(state) {
  const buses = Object.values(state.buses)
    .map((b) => `${b.id}:${STATUS_CODE[b.status] ?? b.status}${b.slotIndex ?? '-'}:${b.passengers}:${b.arrivalOrder ?? '-'}`)
    .sort()
    .join('|');
  const queue = state.queue.map((p) => p.color).join(',');
  const slots = state.slots.map((s) => s.busId ?? '.').join(',');
  const waiting = (state.waiting ?? []).join(',');
  return `${buses}#${queue}#${slots}#${waiting}`;
}

/** 当前局面所有可点击的棋盘车辆 id。 */
export function legalMoveIds(state) {
  if (state.status !== 'playing') return [];
  const out = [];
  for (const bus of Object.values(state.buses)) {
    if (bus.status !== 'board') continue;
    if (validateMove(state, bus.id).ok) out.push(bus.id);
  }
  return out;
}

/**
 * 搜索排序：优先队首同色、其次队列中仍有该颜色的车，最后按 id 稳定排序。
 * 排序只影响「先找到哪条解」，不影响合法性，也不会漏掉其他分支：
 * 调用方会遍历全部开局车辆来统计多样性。
 */
export function orderedMoveIds(state, ids = legalMoveIds(state), preferred = null) {
  const head = state.queue[0]?.color;
  const queueColors = new Set(state.queue.map((p) => p.color));
  const rank = preferred && preferred.length
    ? new Map(preferred.map((id, i) => [id, i]))
    : null;
  return [...ids].sort((a, b) => {
    // 优先沿用关卡参考解法的相对顺序：它一定能通关，可避免搜索在
    // 大量等价分支上耗尽预算；脱离参考解的分支仍会由启发式排序兜底。
    if (rank) {
      const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
    }
    const ba = state.buses[a];
    const bb = state.buses[b];
    const score = (bus) => {
      let s = 0;
      if (bus.color === head) s += 1000;
      if (queueColors.has(bus.color)) s += 100;
      // 同分时偏好长车（容量大，通常更快释放车位压力），但仍保留稳定排序
      s += bus.capacity ?? 0;
      return s;
    };
    return score(bb) - score(ba);
  });
}

/**
 * 快速深拷贝游戏状态。
 * structuredClone 在 31–60 辆车上会明显拖慢搜索；这里只复制会被规则
 * 修改的字段（车辆对象、接客位、队列、等待数组），网格等只读数据共享。
 */
export function cloneState(state) {
  const buses = {};
  for (const [id, bus] of Object.entries(state.buses)) buses[id] = { ...bus };
  return {
    levelId: state.levelId,
    grid: state.grid,
    slotCount: state.slotCount,
    slots: state.slots.map((s) => ({ ...s })),
    buses,
    waiting: [...(state.waiting ?? [])],
    nextArrivalOrder: state.nextArrivalOrder,
    queue: state.queue.map((p) => ({ ...p })),
    moveCount: state.moveCount,
    status: state.status,
  };
}

/**
 * 模拟一次点击：克隆 -> moveBus -> settleAll -> 检查胜负。
 * 返回 { ok, state, won, lost }；调用方的 state 完全不变。
 */
export function simulateMove(state, busId) {
  const child = cloneState(state);
  const res = moveBus(child, busId);
  if (!res.ok) return { ok: false, reason: res.reason, state: child };
  settleAll(child);
  const won = child.status === 'won' || checkWin(child);
  const lost = !won && (child.status === 'lost' || checkLose(child));
  return { ok: true, state: child, won, lost };
}

/**
 * 从给定局面找一条完整通关路径（深度优先 + 状态去重 + 节点预算）。
 * state 不会被修改。
 *
 * 返回 { solvable, aborted, path, nodes, deadlocks, reason }：
 *  - solvable=false 且 aborted=false：在本预算内穷尽了所有可达分支，确认无解；
 *  - aborted=true：预算不足，无法确定，调用方不得当成无解。
 */
export function findPath(state, options = {}) {
  const maxNodes = options.maxNodes ?? SEARCH_LIMITS.MAX_NODES;
  const preferred = Array.isArray(options.preferred) ? options.preferred : null;
  const started = performanceNow();
  if (state.status === 'won') {
    return { solvable: true, aborted: false, path: [], nodes: 0, deadlocks: 0, ms: 0 };
  }
  if (state.status === 'lost' || state.queue.length === 0) {
    return {
      solvable: state.status === 'won',
      aborted: false,
      path: null,
      nodes: 0,
      deadlocks: state.status === 'lost' ? 1 : 0,
      ms: 0,
    };
  }

  let nodes = 0;
  let aborted = false;
  let deadlocks = 0;
  const dead = new Set();
  const rootKey = stateKey(state);

  /** @returns {string[]|null} */
  function dfs(st, path) {
    if (aborted) return null;
    if (nodes >= maxNodes) {
      aborted = true;
      return null;
    }
    nodes += 1;
    const key = stateKey(st);
    if (dead.has(key)) return null;

    const legal = orderedMoveIds(st, undefined, preferred);
    if (legal.length === 0) {
      if (!aborted) dead.add(key);
      return null;
    }

    for (const busId of legal) {
      const sim = simulateMove(st, busId);
      if (!sim.ok) continue;
      if (sim.lost) {
        deadlocks += 1;
        continue;
      }
      const nextPath = [...path, busId];
      if (sim.won) return nextPath;
      const sub = dfs(sim.state, nextPath);
      if (sub) return sub;
      if (aborted) return null;
    }
    if (!aborted) dead.add(key);
    return null;
  }

  const path = dfs(state, []);
  // 根节点状态如果不是 lost，且搜索没有超限但找不到路径，才可确认无解。
  return {
    solvable: !!path,
    aborted,
    path,
    nodes,
    deadlocks,
    ms: performanceNow() - started,
    rootKey,
    reason: path ? null : (aborted ? 'aborted' : 'unsolvable'),
  };
}

/** 全量评估一个关卡：可解性 + 开局多样性 + 分支数量 + 关键决策。 */
export function analyzeLevel(level, options = {}) {
  const started = performanceNow();
  const root = initializeLevel(level);
  settleAll(root);
  const rootKey = stateKey(root);
  if (checkWin(root)) {
    return {
      solvable: true,
      aborted: false,
      openingLegal: 0,
      openingWins: 0,
      solutionCount: 0,
      samplePaths: [[]],
      paths: [],
      openingUnknown: 0,
      nodes: 1,
      deadlocks: 0,
      deadlockReachable: false,
      branching: [],
      criticalSteps: [],
      criticalCount: 0,
      rootKey,
      ms: performanceNow() - started,
    };
  }

  const preferred = Array.isArray(level.solution?.moves) ? level.solution.moves : null;
  const openingIds = orderedMoveIds(root, undefined, preferred);
  const branchNodes = options.branchNodes ?? SEARCH_LIMITS.BRANCH_NODES;
  const criticalBranchNodes = options.criticalBranchNodes ?? Math.min(branchNodes, 6_000);
  const maxSolutions = options.maxSolutions ?? SEARCH_LIMITS.MAX_SOLUTIONS;
  const paths = [];
  const winningIds = [];
  let openingWins = 0;
  let openingUnknown = 0;
  let openingLost = 0;
  let nodes = 1;
  let deadlocks = 0;

  for (const busId of openingIds) {
    // 已找到足够多的可行开局后停止：继续搜索既不会改变「多样性达标」
    // 的结论，也可能在不相关分支上耗尽预算。
    if (openingWins >= maxSolutions) break;
    const sim = simulateMove(root, busId);
    if (!sim.ok) continue;
    if (sim.lost) {
      deadlocks += 1;
      openingLost += 1;
      continue;
    }
    if (sim.won) {
      openingWins += 1;
      winningIds.push(busId);
      if (paths.length < maxSolutions) paths.push([busId]);
      continue;
    }
    const r = findPath(sim.state, { maxNodes: branchNodes, preferred });
    nodes += r.nodes;
    deadlocks += r.deadlocks;
    if (r.solvable) {
      openingWins += 1;
      winningIds.push(busId);
      if (paths.length < maxSolutions) paths.push([busId, ...r.path]);
    } else if (r.aborted) {
      openingUnknown += 1;
    }
  }

  const truncatedByMaxSolutions = paths.length >= maxSolutions && openingIds.length > paths.length;
  const firstPath = paths[0] ?? [];
  // 沿第一条解法回放，记录每一步「可选的合法操作数量」。
  const branching = [];
  const criticalSteps = [];
  const criticalDepth = options.criticalDepth ?? SEARCH_LIMITS.CRITICAL_DEPTH;
  let replay = root;
  for (let step = 0; step < firstPath.length; step++) {
    const legal = orderedMoveIds(replay);
    branching.push(legal.length);
    // 只对前 criticalDepth 步做「换别的车会不会输」的证明，避免预算失控。
    if (step < criticalDepth && firstPath.length > 1) {
      const chosen = firstPath[step];
      let winningAlternatives = 0;
      let provenLosing = 0;
      let unknownAlternatives = 0;
      for (const alt of legal) {
        if (alt === chosen) continue;
        const sim = simulateMove(replay, alt);
        if (!sim.ok) continue;
        if (sim.lost) { provenLosing += 1; continue; }
        if (sim.won) { winningAlternatives += 1; continue; }
        const r = findPath(sim.state, { maxNodes: criticalBranchNodes, preferred });
        if (r.solvable) winningAlternatives += 1;
        else if (r.aborted) unknownAlternatives += 1;
        else provenLosing += 1;
      }
      if (winningAlternatives === 0 && unknownAlternatives === 0 && provenLosing > 0) {
        criticalSteps.push({ step: step + 1, busId: chosen, legal: legal.length, alternatives: provenLosing });
      }
    }
    const stepSim = simulateMove(replay, firstPath[step]);
    if (!stepSim.ok) break;
    replay = stepSim.state;
  }
  const aborted = openingWins === 0 && openingUnknown > 0;
  return {
    solvable: openingWins > 0,
    aborted,
    truncatedByMaxSolutions,
    openingLegal: openingIds.length,
    openingWins,
    solutionCount: openingWins,
    samplePaths: paths,
    paths,
    winningOpeningIds: winningIds,
    openingUnknown,
    openingLost,
    nodes,
    deadlocks,
    deadlockReachable: deadlocks > 0 || openingLost > 0,
    branching,
    minBranching: branching.length ? Math.min(...branching) : 0,
    maxBranching: branching.length ? Math.max(...branching) : 0,
    avgBranching: branching.length ? branching.reduce((a, b) => a + b, 0) / branching.length : 0,
    criticalSteps,
    criticalCount: criticalSteps.length,
    rootKey,
    ms: performanceNow() - started,
  };
}

/**
 * 操作风险分析（提示系统使用）：
 *  - proven：能证明这一步后无通关路径（或直接死局）；
 *  - safe：能证明仍可通关；
 *  - unknown：预算不足，不能下结论（提示只能用「可能」）；
 */
export function evaluateMoveRisk(state, busId, options = {}) {
  if (!state || state.status !== 'playing') return { level: 'safe', reason: 'not-playing' };
  const maxNodes = options.maxNodes ?? SEARCH_LIMITS.RISK_NODES;
  const sim = simulateMove(state, busId);
  if (!sim.ok) return { level: 'safe', reason: sim.reason ?? 'illegal' };
  if (sim.won) return { level: 'safe', reason: 'wins' };
  if (sim.lost) return { level: 'proven', reason: 'immediate-lost', child: sim.state };

  const current = findPath(state, { maxNodes });
  if (!current.solvable && !current.aborted) {
    // 当前局面本身已经无解：这一步不能「证明」是它导致的。
    return { level: 'unknown', reason: 'already-unsolvable' };
  }
  const after = findPath(sim.state, { maxNodes });
  if (!after.solvable && !after.aborted && current.solvable) {
    return { level: 'proven', reason: 'loses-all-paths', child: sim.state };
  }
  if (after.solvable) return { level: 'safe', reason: 'still-solvable', child: sim.state };
  return { level: 'unknown', reason: after.aborted ? 'search-budget' : 'unclear' };
}

function performanceNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}