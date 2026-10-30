/**
 * 《猫咪巴士大疏通》关卡统一验证入口
 * ------------------------------------------------------------
 * 对注册表（levelRegistry.js -> levels.js）中的每一关，依次执行：
 *  1. 配置校验（validateLevelConfig）：格式、几何（越界/重叠）、
 *     队列-车辆颜色与容量一致性；不通过则跳过后续模拟并给出原因；
 *  2. 可解性：
 *     - 车辆 ≤ 20 的小关卡：用与游戏运行时完全相同的 logic.js 规则做 BFS；
 *     - 第 10 关起的高密度关卡：逐步回放参考解法（每步真实校验并结算），
 *       作为严格的可解性证明；不展开爆炸式状态空间；
 *  3. 参考解法回放：levels.js 声明的 solution.moves 是否真实通关；
 *  4. par 规则：小关卡比对 BFS 最短解；高密度关卡 par = 参考解步数；
 *  5. 死锁陷阱（仅 BFS 关卡）：是否存在可达的失败状态；
 *  6. 容量对照（仅 BFS 关卡）：少一个接客位是否仍可解；
 *  7. 设计约束：所有关卡统一 4 个接客位；第 10 关起 >30 辆，
 *     后期逐步达到 44/52/60 辆；队列长度必须等于车辆总容量；
 *     每辆车容量必须是 2/4/6，且第 10 关起每关混用三种容量；
 *     不允许整行/整列被车辆占满（错落布局）；
 *     开局必须有「队首同色且路径畅通」的巴士；限制单点阻挡扇出、
 *     最大直接阻挡数与依赖链下限，避免关键车辆被同一辆车锁死。
 *
 * 运行：node src/game/solver.js   （或 npm run verify）
 * ------------------------------------------------------------
 */
import {
  cellsOfBus,
  exitPathOfBus,
  initializeLevel,
  moveBus,
  settleAll,
  checkWin,
  checkLose,
  validateMove,
  SLOT_COUNT,
  BUS_CAPACITIES,
  lengthForCapacity,
} from './logic.js';
import { LEVELS } from './levels.js';
import { validateLevelConfig, validateRegistry } from './levelRegistry.js';
import { analyzeLevel, stateKey, SEARCH_LIMITS } from './search.js';

const SEARCH_LIMIT = 2_000_000;
/** 车辆数超过该阈值时，完整 BFS 的状态空间不可控；改用参考解法 + 有界 DFS 证明可解性。 */
const BFS_MAX_BUSES = 20;

/**
 * 按关卡规模选择多样性分析预算：
 * - 小关卡：较深的关键决策检查（精确 BFS 另有结论）；
 * - 高密度关卡：限制关键步数，避免浏览器/CI 被无上限搜索拖慢。
 */
function diversityOptions(level) {
  const dense = level.buses.length > 30;
  return {
    // 高密度关只需证明「至少 3 条不同开局可通关」；达到目标立即停止，
    // 避免在不相关的不可解分支上耗尽预算。
    branchNodes: dense ? 1_500 : SEARCH_LIMITS.BRANCH_NODES,
    criticalDepth: dense ? 2 : 12,
    criticalBranchNodes: dense ? 250 : 6_000,
    maxSolutions: dense ? 3 : SEARCH_LIMITS.MAX_SOLUTIONS,
  };
}

/**
 * 高密度关卡：不展开全状态 BFS，而是用与游戏完全一致的 logic.js
 * 逐辆回放参考解法。每一步都必须真实合法，结束时必须真实通关，
 * 因此这仍然是严格的「可解性证明」，不是抽样/猜测。
 */
function verifyReferenceSolution(level) {
  const started = performance.now();
  const s = verifySolution(level);
  const moves = level.solution?.moves ?? [];
  return {
    solvable: s.ok,
    par: moves.length,
    moves: moves.slice(),
    deadlockReachable: null,
    states: null,
    deadlocks: null,
    ms: performance.now() - started,
    aborted: false,
    method: 'reference',
    failure: s.ok ? null : s,
  };
}

/** 棋盘结构统计：阻挡边数、最长依赖链、初始可动车辆数、单点扇出、队首匹配。 */
function layoutStats(level) {
  const occ = new Map();
  for (const bus of level.buses) {
    for (const c of cellsOfBus(bus)) occ.set(`${c.x},${c.y}`, bus.id);
  }
  const blockers = new Map(level.buses.map((b) => [b.id, new Set()]));
  const fan = new Map(level.buses.map((b) => [b.id, 0]));
  for (const bus of level.buses) {
    for (const c of exitPathOfBus(bus, level.grid)) {
      const id = occ.get(`${c.x},${c.y}`);
      if (id && id !== bus.id) blockers.get(bus.id).add(id);
    }
    for (const id of blockers.get(bus.id)) fan.set(id, (fan.get(id) ?? 0) + 1);
  }
  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0; // 防御：异常循环配置不应让统计崩溃
    visiting.add(id);
    let d = 0;
    for (const b of blockers.get(id)) d = Math.max(d, 1 + depth(b));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  let edges = 0;
  let chain = 0;
  let free = 0;
  let maxBlocked = 0;
  let headMatch = 0;
  const head = level.queue?.[0];
  for (const bus of level.buses) {
    const blockedCount = blockers.get(bus.id).size;
    edges += blockedCount;
    chain = Math.max(chain, depth(bus.id));
    maxBlocked = Math.max(maxBlocked, blockedCount);
    if (blockedCount === 0) {
      free += 1;
      if (bus.color === head) headMatch += 1;
    }
  }
  return {
    edges,
    chain,
    free,
    headMatch,
    maxFan: Math.max(0, ...fan.values()),
    maxBlocked,
  };
}

/**
 * BFS 求解。返回：
 *  { solvable, par, moves, deadlockReachable, states, deadlocks, ms, aborted }
 * moves 为点击驶出的巴士 id 序列（最短解之一）。
 */
function solve(level) {
  const started = performance.now();
  const root = initializeLevel(level);
  settleAll(root);
  if (checkWin(root)) {
    return { solvable: true, par: 0, moves: [], deadlockReachable: false, states: 1, deadlocks: 0, ms: 0 };
  }

  const seen = new Set([stateKey(root)]);
  const frontier = [{ state: root, path: [] }];
  let cursor = 0;
  let deadlocks = 0;

  while (cursor < frontier.length) {
    if (seen.size > SEARCH_LIMIT) {
      return {
        solvable: false, aborted: true, states: seen.size, deadlocks,
        ms: performance.now() - started,
      };
    }
    const { state, path } = frontier[cursor++];
    for (const bus of Object.values(state.buses)) {
      if (bus.status !== 'board') continue;
      if (!validateMove(state, bus.id).ok) continue;

      const child = structuredClone(state);
      const res = moveBus(child, bus.id);
      if (!res.ok) continue; // 理论上不会发生（已 validate）
      settleAll(child);

      if (checkLose(child)) {
        deadlocks += 1; // 有陷阱：玩家走错会失败
        continue;
      }
      const key = stateKey(child);
      if (seen.has(key)) continue;
      seen.add(key);

      const nextPath = [...path, bus.id];
      if (checkWin(child)) {
        return {
          solvable: true, par: nextPath.length, moves: nextPath,
          deadlockReachable: deadlocks > 0, states: seen.size, deadlocks,
          ms: performance.now() - started,
        };
      }
      frontier.push({ state: child, path: nextPath });
    }
  }
  return {
    solvable: false, par: -1, moves: [], deadlockReachable: deadlocks > 0,
    states: seen.size, deadlocks, ms: performance.now() - started,
  };
}

/** 验证 levels.js 声明的参考解法是否可通关。 */
function verifySolution(level) {
  let state = initializeLevel(level);
  for (const busId of level.solution.moves) {
    const res = moveBus(state, busId);
    if (!res.ok) return { ok: false, step: busId, reason: res.reason };
    settleAll(state);
    if (state.status === 'lost') return { ok: false, step: busId, reason: 'deadlock' };
  }
  return { ok: checkWin(state), reason: checkWin(state) ? null : '未在解法结束时达成胜利' };
}

/* ---------------- CLI 输出 ---------------- */

let allPass = true;
console.log('《巴士大疏通》关卡统一验证（配置校验 + BFS，规则与游戏运行时完全一致）\n');

// 注册表级别检查（跨关卡 id 唯一性等）
const reg = validateRegistry(LEVELS);
if (!reg.ok) {
  allPass = false;
  console.log('注册表错误：');
  for (const e of reg.errors) console.log(`  ❌ ${e}`);
  console.log('');
}

const results = [];

for (const level of LEVELS) {
  const head = `第 ${level.id} 关《${level.name}》`;

  // 1) 配置校验
  const v = validateLevelConfig(level);
  if (!v.ok) {
    allPass = false;
    console.log(`${head} ❌ 配置不合法，已跳过模拟：`);
    for (const e of v.errors) console.log(`    ❌ ${e}`);
    for (const w of v.warnings) console.log(`    ⚠ ${w}`);
    continue;
  }

  // 2) 可解性：小关卡做完整 BFS；高密度关卡做参考解法逐步回放
  const useBfs = level.buses.length <= BFS_MAX_BUSES;
  const r = useBfs ? solve(level) : verifyReferenceSolution(level);
  const s = verifySolution(level);
  // 解法多样性：用真实规则搜索不同开局决策，并为每条可行决策找到完整通关路径。
  const diversity = analyzeLevel(level, diversityOptions(level));
  const parMismatch = useBfs && r.solvable && level.solution?.par != null && level.solution.par !== r.par;
  const ok = (r.solvable || diversity.solvable) && !r.aborted && s.ok && !parMismatch;

  // 6) 容量对照：少一个接客位是否仍可解（高密度关卡跳过，避免误标）
  let weaker = null;
  if (!useBfs) {
    weaker = 'skipped';
  } else if (level.slots > 1) {
    const wr = solve({ ...level, slots: level.slots - 1 });
    weaker = wr.aborted ? 'aborted' : wr.solvable ? 'solvable' : 'unsolvable';
  } else {
    weaker = 'none';
  }

  // 7) 设计约束：所有关卡统一 4 个接客位；第 10 关起必须 >30 辆，之后继续递增。
  const ls = layoutStats(level);
  const designErrors = [];
  if (level.slots !== SLOT_COUNT) {
    designErrors.push(`第 ${level.id} 关接客位 ${level.slots}，不满足「所有关卡统一 ${SLOT_COUNT} 个」`);
  }
  if (level.id >= 10 && level.buses.length <= 30) {
    designErrors.push(`第 ${level.id} 关车辆数 ${level.buses.length}，不满足「第 10 关起 >30 辆」`);
  }
  if (level.id >= 20 && level.buses.length < 35) {
    designErrors.push(`第 ${level.id} 关车辆数 ${level.buses.length}，后期应达到 35–60 辆`);
  }
  if (level.id >= 30 && level.buses.length < 44) {
    designErrors.push(`第 ${level.id} 关车辆数 ${level.buses.length}，后期应达到 44–60 辆`);
  }
  if (level.id >= 40 && level.buses.length < 52) {
    designErrors.push(`第 ${level.id} 关车辆数 ${level.buses.length}，终盘应达到 52–60 辆`);
  }
  // 协同设计约束：开局正反馈、队首匹配、单点阻挡扇出、逐步解锁链。
  if (ls.headMatch < 1) {
    designErrors.push(`第 ${level.id} 关开局没有「队首颜色且可驶出」的巴士`);
  }
  if (level.id >= 10) {
    const minOpening = Math.max(4, Math.ceil(level.buses.length * 0.06));
    if (ls.free < minOpening) {
      designErrors.push(`第 ${level.id} 关开局可动 ${ls.free} 辆，低于 ${minOpening} 辆（正反馈不足）`);
    }
    if (ls.free > level.buses.length * 0.45) {
      designErrors.push(`第 ${level.id} 关开局可动 ${ls.free} 辆，超过 45%（过于开放）`);
    }
    if (ls.maxFan > 10) {
      designErrors.push(`第 ${level.id} 关单辆车最多阻挡 ${ls.maxFan} 辆，超过 10（关键车被单点锁死）`);
    }
    if (ls.maxBlocked > 8) {
      designErrors.push(`第 ${level.id} 关单车最多被 ${ls.maxBlocked} 辆挡住，超过 8`);
    }
    if (ls.chain < 3) {
      designErrors.push(`第 ${level.id} 关依赖链仅 ${ls.chain} 层，缺少逐步解锁结构`);
    }
  }
  const capSum = level.buses.reduce((sum, b) => sum + b.capacity, 0);
  if (level.id >= 10 && capSum !== level.queue.length) {
    designErrors.push(`第 ${level.id} 关队列长度 ${level.queue.length} ≠ 车辆总容量 ${capSum}`);
  }
  if (!level.buses.every((b) => BUS_CAPACITIES.includes(b.capacity))) {
    designErrors.push(`第 ${level.id} 关存在非 2/4/6 的车辆容量`);
  }
  if (!level.buses.every((b) => b.len === lengthForCapacity(b.capacity))) {
    designErrors.push(`第 ${level.id} 关存在容量与车身长度不匹配的车辆`);
  }
  if (level.id >= 10 && new Set(level.buses.map((b) => b.capacity)).size !== BUS_CAPACITIES.length) {
    designErrors.push(`第 ${level.id} 关没有混用 2/4/6 三种容量`);
  }
  // 解法多样性：至少要有 2 个不同开局决策都能真实通关。
  if (diversity.aborted && !diversity.solvable) {
    designErrors.push(`第 ${level.id} 关解法搜索预算耗尽，无法证明可解；建议调整布局或提高搜索预算，而不是直接判为无解`);
  }
  if (!diversity.aborted && diversity.solutionCount < 2) {
    designErrors.push(`第 ${level.id} 关只有 ${diversity.solutionCount} 条可行开局决策（要求至少 2 条）`);
  }
  // 关键决策是信息而非一律禁止：高难度关允许存在，但必须被记录到统计中，
  // 不作为失败条件，避免为了「零关键步」破坏设计难度。
  // 错落布局：不允许任何一整行/一整列被车辆完全占满。
  const rowFill = new Map();
  const colFill = new Map();
  for (const bus of level.buses) {
    for (const cell of cellsOfBus(bus)) {
      rowFill.set(cell.y, (rowFill.get(cell.y) ?? 0) + 1);
      colFill.set(cell.x, (colFill.get(cell.x) ?? 0) + 1);
    }
  }
  if ([...rowFill.values()].some((n) => n >= level.grid.cols)
      || [...colFill.values()].some((n) => n >= level.grid.rows)) {
    designErrors.push(`第 ${level.id} 关存在被车辆占满的整行或整列（布局过于规则）`);
  }
  // 最长连续占格：避免连续十几格的车墙仍然像规则网格。
  const filled = new Set(level.buses.flatMap((bus) => cellsOfBus(bus).map((c) => `${c.x},${c.y}`)));
  let longestRun = 0;
  for (let y = 0; y < level.grid.rows; y++) {
    let run = 0;
    for (let x = 0; x < level.grid.cols; x++) {
      run = filled.has(`${x},${y}`) ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }
  }
  for (let x = 0; x < level.grid.cols; x++) {
    let run = 0;
    for (let y = 0; y < level.grid.rows; y++) {
      run = filled.has(`${x},${y}`) ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }
  }
  if (longestRun > Math.ceil(level.grid.cols * 0.72)) {
    designErrors.push(`第 ${level.id} 关最长连续车墙 ${longestRun} 格（上限 ${Math.ceil(level.grid.cols * 0.72)}）`);
  }
  if (designErrors.length) allPass = false;

  if (!ok) allPass = false;

  const solveText = r.aborted
    ? '搜索超限！'
    : r.solvable
      ? useBfs ? `是（最短 ${r.par} 步）` : `是（参考解 ${r.par} 步，逐步回放）`
      : '否！';

  console.log(
    `${head} ${ok && !designErrors.length ? '✅' : '❌'}` +
      `  车辆 ${level.buses.length} · 接客位 ${level.slots}` +
      `  阻挡 ${ls.edges} 条 / 链 ${ls.chain} 层` +
      `  开局可动 ${ls.free} / 队首同色 ${ls.headMatch} / 扇出 ${ls.maxFan}` +
      `  可解: ${solveText}` +
      `  解法多样性: 至少 ${diversity.solutionCount}/${diversity.openingLegal} 个开局${diversity.aborted ? `（${diversity.openingUnknown} 个未确定）` : ''}` +
      `  关键步: ${diversity.criticalCount}` +
      `  ${useBfs ? `BFS 状态 ${r.states}` : 'BFS 已跳过（高密度）'} · ${r.ms.toFixed(1)}ms + 多样性 ${diversity.ms.toFixed(0)}ms` +
      `  声明解法: ${s.ok ? '有效' : `无效(${s.reason})`}` +
      `  少一位: ${weaker === 'unsolvable' ? '无解' : weaker === 'solvable' ? '仍可解' : weaker === 'aborted' ? '搜索超限(未验证)' : weaker === 'skipped' ? '跳过(高密度)' : '—'}`
  );
  if (r.solvable && useBfs) {
    console.log(`    最短解: ${r.moves.join(' -> ')}`);
  }
  if (!s.ok) {
    console.log(`    ⚠ 声明解法问题: ${JSON.stringify(s)}`);
  }
  if (parMismatch) {
    console.log(`    ⚠ par 不一致：声明 ${level.solution.par}，实际 ${r.par}`);
  }
  for (const e of designErrors) console.log(`    ❌ ${e}`);
  for (const w of v.warnings) console.log(`    ⚠ ${w}`);

  const challenge = level.id <= 5 ? '核心循环教学'
    : level.id <= 8 ? '基础阻挡/方向'
      : level.id <= 9 ? '首次队列顺序'
        : level.id <= 14 ? '协同起步（2辆组）'
          : level.id <= 24 ? '组交换入门'
            : level.id <= 34 ? '多模板周转'
              : level.id <= 44 ? '高密度组交换'
                : '终盘高密度周转';

  results.push({
    id: level.id,
    name: level.name,
    challenge,
    difficulty: level.difficulty ?? null,
    buses: level.buses.length,
    slots: level.slots,
    grid: `${level.grid.cols}x${level.grid.rows}`,
    queue: level.queue.length,
    edges: ls.edges,
    chain: ls.chain,
    free: ls.free,
    headMatch: ls.headMatch,
    maxFan: ls.maxFan,
    maxBlocked: ls.maxBlocked,
    par: r.solvable ? r.par : null,
    states: r.states,
    deadlocks: r.deadlocks,
    ms: r.ms,
    solvable: r.solvable,
    aborted: !!r.aborted,
    method: useBfs ? 'bfs' : 'reference',
    declaredSolutionOk: s.ok,
    parMatches: !parMismatch,
    weakerSlots: weaker,
    designErrors,
    // 解法多样性指标（bounded search，budget 耗尽时以 aborted 标注）
    openingLegal: diversity.openingLegal,
    solutionCount: diversity.solutionCount,
    openingUnknown: diversity.openingUnknown,
    diversityAborted: diversity.aborted,
    criticalCount: diversity.criticalCount,
    criticalSteps: diversity.criticalSteps.map((c) => c.step),
    minBranching: diversity.minBranching,
    maxBranching: diversity.maxBranching,
    avgBranching: diversity.avgBranching,
    deadlockReachable: diversity.deadlockReachable,
    diversityMs: diversity.ms,
  });
}

console.log(allPass ? `\n全部 ${LEVELS.length} 关验证通过 ✅` : '\n存在未通过的关卡 ❌');

if (process.argv.includes('--write-stats')) {
  const fs = await import('node:fs');
  const header = [
    '| 关 | 名称 | 主要挑战 | 车辆 | 接客位 | 场地 | 阻挡/链 | 开局/队首 | 扇出 | 参考步数 | 验证方式 | BFS 状态 | 求解耗时 | 可行开局 | 关键步 | 分支/步 | 死局可达 | 少一位 | 验证 |',
    '| ---: | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |',
  ];
  const rows = results.map((r) => {
    const weaker = r.weakerSlots === 'unsolvable' ? '无解'
      : r.weakerSlots === 'solvable' ? '仍可解'
        : r.weakerSlots === 'aborted' ? '未验证'
          : r.weakerSlots === 'skipped' ? '跳过' : '—';
    const method = r.method === 'bfs' ? 'BFS 最短解' : '参考解回放';
    const states = r.states == null ? '—' : String(r.states);
    const opening = r.diversityAborted
      ? `至少 ${r.solutionCount}/${r.openingLegal}（${r.openingUnknown} 未知）`
      : `${r.solutionCount}/${r.openingLegal}`;
    return `| ${r.id} | ${r.name} | ${r.challenge} | ${r.buses} | ${r.slots} | ${r.grid} | ${r.edges}/${r.chain} | ${r.free}/${r.headMatch} | ${r.maxFan} | ${r.par} | ${method} | ${states} | ${r.ms.toFixed(1)}+${r.diversityMs.toFixed(0)} ms | ${opening} | ${r.criticalCount} | ${r.minBranching}–${r.maxBranching} | ${r.deadlockReachable ? '是' : '否'} | ${weaker} | ${r.solvable && !r.aborted && r.declaredSolutionOk && r.parMatches && !r.designErrors.length ? '✅' : '❌'} |`;
  });
  fs.writeFileSync(new URL('../../LEVEL_STATS.md', import.meta.url),
    `# 关卡统计（由 node src/game/solver.js --write-stats 生成）\n\n` +
    `- 车辆 / 接客位 / 场地：关卡配置；所有关卡统一 4 个基础接客位，容量 2/4/6 与车身 2/3/4 格严格对应，第 10 关起车辆数 31–60。\n` +
    `- 容量分布：第 10–50 关由 CAPACITY_DISTRIBUTION 统一生成，整体约 4 座 64% / 2 座 22% / 6 座 14%，且逐关均为 4 座最多。\n` +
    `- 阻挡/链：阻挡关系条数 / 最长依赖链层数。\n` +
    `- 开局/队首：开局路径畅通的车辆数 / 其中与队首猫咪同色的车辆数。\n` +
    `- 扇出：单辆车最多直接阻挡多少辆车；用于避免所有关键车被同一辆车锁死。\n` +
    `- 参考步数：第 1–9 关为 BFS 最短步数；第 10–50 关为参考解法步数（= 车辆数，每辆车都必须驶出一次）。\n` +
    `- 验证方式：小关卡使用完整 BFS；高密度关卡使用与游戏同一套 logic.js 的参考解逐步回放 + 有界 DFS 寻找多条真实路径。\n` +
    `- BFS 状态 / 耗时：BFS 为去重状态数与耗时；高密度关卡显示 — + 多样性分析耗时。\n` +
    `- 可行开局：不同开局点击中，找到完整通关路径的数量 / 开局合法车辆总数；括号内为预算耗尽、无法确定的个数。\n` +
    `- 关键步：沿第一条解法回放的前若干步中，只有唯一获胜选择、其余选择可证明失败的步数（高密度关只检查前 2 步）。\n` +
    `- 分支/步：沿解法每步可选合法操作的最小–最大值。\n` +
    `- 死局可达：有界搜索中是否遇到过直接判负的局面；存在不代表关卡无解，只代表存在需要避免的错步。\n` +
    `- 少一位：把基础接客位数量减 1 后再完整跑一次 BFS；高密度关卡跳过该对照，不把“没搜”当成“无解”。\n` +
    `- 验证：配置校验 + 可解性 + 声明解法回放 + 至少 2 条可行开局 + par 规则 + 协同设计约束，全部通过才为 ✅。\n\n` +
    header.join('\n') + '\n' + rows.join('\n') + '\n');
  console.log('\n已写入 LEVEL_STATS.md');
}

process.exitCode = allPass ? 0 : 1;