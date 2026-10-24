/**
 * 《巴士大疏通》关卡统一验证入口
 * ------------------------------------------------------------
 * 对注册表（levelRegistry.js -> levels.js）中的每一关，依次执行：
 *  1. 配置校验（validateLevelConfig）：格式、几何（越界/重叠）、
 *     队列-车辆颜色与容量一致性；不通过则跳过后续模拟并给出原因；
 *  2. 可解性：用与游戏运行时完全相同的 logic.js 规则做 BFS 搜索，
 *     并记录展开状态数与耗时；
 *  3. 参考解法回放：levels.js 声明的 solution.moves 是否真实通关；
 *  4. par 一致性：声明 par 是否等于 BFS 最短解步数；
 *  5. 死锁陷阱：是否存在可达的失败状态（信息项，教学关允许没有）；
 *  6. 容量对照（接客位 > 1 时）：把接客位减 1 再搜索一次，用来判断
 *     「少一个接客位是否仍然可解」。搜索超限时明确标为“未验证”，
 *     绝不把“没搜到”当成“无解”。
 *
 * 运行：node src/game/solver.js   （或 npm run verify）
 * 新增关卡只需在 levels.js 追加配置并重跑本脚本，无需改动其他文件。
 *
 * 巴士只「驶出」而不在棋盘内移动，棋盘布局永远不变，
 * 因此状态签名只需 buses(status/slot/passengers) + queue + slots。
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
} from './logic.js';
import { LEVELS } from './levels.js';
import { validateLevelConfig, validateRegistry } from './levelRegistry.js';

const SEARCH_LIMIT = 2_000_000;

function stateKey(state) {
  const buses = Object.values(state.buses)
    .map((b) => `${b.id}:${b.status[0]}${b.slotIndex ?? '-'}:${b.passengers}`)
    .sort()
    .join('|');
  const queue = state.queue.map((p) => p.color).join(',');
  const slots = state.slots.map((s) => s.busId ?? '.').join(',');
  return `${buses}#${queue}#${slots}`;
}

/** 棋盘结构统计：阻挡边数、最长依赖链、初始可动车辆数。 */
function layoutStats(level) {
  const occ = new Map();
  for (const bus of level.buses) {
    for (const c of cellsOfBus(bus)) occ.set(`${c.x},${c.y}`, bus.id);
  }
  const blockers = new Map(level.buses.map((b) => [b.id, new Set()]));
  for (const bus of level.buses) {
    for (const c of exitPathOfBus(bus, level.grid)) {
      const id = occ.get(`${c.x},${c.y}`);
      if (id && id !== bus.id) blockers.get(bus.id).add(id);
    }
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
  for (const bus of level.buses) {
    edges += blockers.get(bus.id).size;
    chain = Math.max(chain, depth(bus.id));
    if (blockers.get(bus.id).size === 0) free += 1;
  }
  return { edges, chain, free };
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

  // 2) BFS 可解性 + 3) 参考解法回放
  const r = solve(level);
  const s = verifySolution(level);
  const parMismatch = r.solvable && level.solution?.par != null && level.solution.par !== r.par;
  const ok = r.solvable && !r.aborted && s.ok && !parMismatch;

  // 6) 容量对照：少一个接客位是否仍可解（只做信息项，不改变本关判定）
  let weaker = null;
  if (level.slots > 1) {
    const wr = solve({ ...level, slots: level.slots - 1 });
    weaker = wr.aborted ? 'aborted' : wr.solvable ? 'solvable' : 'unsolvable';
  } else {
    weaker = 'none';
  }

  const ls = layoutStats(level);
  if (!ok) allPass = false;

  console.log(
    `${head} ${ok ? '✅' : '❌'}` +
      `  车辆 ${level.buses.length} · 接客位 ${level.slots}` +
      `  阻挡 ${ls.edges} 条 / 链 ${ls.chain} 层` +
      `  可解: ${r.aborted ? '搜索超限！' : r.solvable ? `是（最短 ${r.par} 步）` : '否！'}` +
      `  BFS 状态 ${r.states} · ${r.ms.toFixed(1)}ms` +
      `  声明解法: ${s.ok ? '有效' : `无效(${s.reason})`}` +
      `  少一位: ${weaker === 'unsolvable' ? '无解' : weaker === 'solvable' ? '仍可解' : weaker === 'aborted' ? '搜索超限(未验证)' : '—'}`
  );
  if (r.solvable) {
    console.log(`    最短解: ${r.moves.join(' -> ')}`);
  }
  if (!s.ok) {
    console.log(`    ⚠ 声明解法问题: ${JSON.stringify(s)}`);
  }
  if (parMismatch) {
    console.log(`    ⚠ par 不一致：声明 ${level.solution.par}，实际 ${r.par}`);
  }
  for (const w of v.warnings) console.log(`    ⚠ ${w}`);

  const challenge = level.id <= 5 ? '核心循环教学'
    : level.id <= 8 ? '基础阻挡/方向'
      : level.id <= 10 ? '首次等待进位'
      : level.id <= 20 ? '顺序交叉'
        : level.id <= 26 ? '容量调度'
          : level.id <= 30 ? '三位调度'
            : level.id <= 40 ? '高密度链'
              : '终盘高密度链';

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
    par: r.solvable ? r.par : null,
    states: r.states,
    deadlocks: r.deadlocks,
    ms: r.ms,
    solvable: r.solvable,
    aborted: !!r.aborted,
    declaredSolutionOk: s.ok,
    parMatches: !parMismatch,
    weakerSlots: weaker,
  });
}

console.log(allPass ? `\n全部 ${LEVELS.length} 关验证通过 ✅` : '\n存在未通过的关卡 ❌');

if (process.argv.includes('--write-stats')) {
  const fs = await import('node:fs');
  const header = [
    '| 关 | 名称 | 主要挑战 | 车辆 | 接客位 | 场地 | 阻挡/链 | 最短步数 | BFS 状态 | 求解耗时 | 少一位 | 验证 |',
    '| ---: | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  const rows = results.map((r) => {
    const weaker = r.weakerSlots === 'unsolvable' ? '无解'
      : r.weakerSlots === 'solvable' ? '仍可解'
        : r.weakerSlots === 'aborted' ? '未验证' : '—';
    return `| ${r.id} | ${r.name} | ${r.challenge} | ${r.buses} | ${r.slots} | ${r.grid} | ${r.edges}/${r.chain} | ${r.par} | ${r.states} | ${r.ms.toFixed(1)} ms | ${weaker} | ${r.solvable && !r.aborted && r.declaredSolutionOk && r.parMatches ? '✅' : '❌'} |`;
  });
  fs.writeFileSync(new URL('../../LEVEL_STATS.md', import.meta.url),
    `# 关卡统计（由 node src/game/solver.js --write-stats 生成）\n\n` +
    `- 车辆 / 接客位 / 场地：关卡配置。\n` +
    `- 阻挡/链：阻挡关系条数 / 最长依赖链层数。\n` +
    `- 最短步数、BFS 状态、求解耗时：与游戏运行时同一套 logic.js 规则；状态数为 BFS 去重后的已访问状态数（找到最短解时停止），耗时为本机实测。\n` +
    `- 少一位：把接客位数量减 1 后再完整跑一次 BFS；“无解”表示搜索确实跑完且无解，“未验证”表示搜索超限，绝不当作无解。\n` +
    `- 验证：配置校验 + BFS 可解 + 声明解法回放 + par 一致，全部通过才为 ✅。\n\n` +
    header.join('\n') + '\n' + rows.join('\n') + '\n');
  console.log('\n已写入 LEVEL_STATS.md');
}

process.exitCode = allPass ? 0 : 1;