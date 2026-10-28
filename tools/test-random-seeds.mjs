/**
 * 不同随机种子的关卡回归测试
 * ------------------------------------------------------------
 * 用生成器相同的约束，换不同 salt（随机种子）生成一批新关卡，
 * 每个都检查：
 *  1. 配置合法；
 *  2. 参考解逐辆回放真实通关；
 *  3. 有界 DFS 能证明可解；
 *  4. 至少 2 个不同开局决策存在完整通关路径；
 *  5. 状态一致性；
 *  6. 搜索是否在预算内得出结论（aborted 记为「未确定」，不冒充无解）。
 *
 * 运行：npm run test:seeds
 * 输出：控制台 + RANDOM_SEED_STATS.md
 */
import fs from 'node:fs';
import {
  initializeLevel,
  moveBus,
  settleAll,
  checkWin,
  validateStateInvariants,
} from '../src/game/logic.js';
import { validateLevelConfig } from '../src/game/levelRegistry.js';
import { analyzeLevel } from '../src/game/search.js';
import { buildLevel } from './generate-levels.mjs';

const CASES = [
  { levelId: 12, salt: 1 },
  { levelId: 18, salt: 2 },
  { levelId: 24, salt: 3 },
  { levelId: 30, salt: 4 },
  { levelId: 36, salt: 5 },
  { levelId: 42, salt: 6 },
  { levelId: 48, salt: 7 },
  { levelId: 50, salt: 8 },
  { levelId: 15, salt: 101 },
  { levelId: 27, salt: 202 },
  { levelId: 39, salt: 303 },
  { levelId: 50, salt: 404 },
];

function replay(level) {
  const state = initializeLevel(level);
  settleAll(state);
  if (!validateStateInvariants(state).ok) return { ok: false, reason: 'initial invariants' };
  for (const busId of level.solution.moves) {
    const res = moveBus(state, busId);
    if (!res.ok) return { ok: false, reason: `${busId}: ${res.reason}` };
    settleAll(state);
    if (!validateStateInvariants(state).ok) return { ok: false, reason: `${busId}: invariants` };
    if (state.status === 'lost') return { ok: false, reason: `${busId}: deadlock` };
  }
  return { ok: checkWin(state), steps: state.moveCount };
}

const rows = [];
let failed = 0;
console.log('不同随机种子的关卡回归（可解性 / 解法多样性 / 搜索预算）\n');

for (const { levelId, salt } of CASES) {
  const started = performance.now();
  let result;
  try {
    result = buildLevel(levelId, new Set(), { salt, minOpeningSolutions: 2 });
  } catch (err) {
    failed += 1;
    rows.push({ levelId, salt, ok: false, note: `生成失败：${err.message}` });
    console.log(`- 关卡模板 ${levelId} / 种子 ${salt} ❌ 生成失败：${err.message}`);
    continue;
  }

  const level = result.level;
  const config = validateLevelConfig(level);
  const sim = replay(level);
  const diversity = analyzeLevel(level, { branchNodes: 1500, criticalDepth: 1, maxSolutions: 3 });
  const ok = config.ok
    && sim.ok
    && diversity.solvable
    && !diversity.aborted
    && diversity.solutionCount >= 2
    && diversity.samplePaths.length >= 2;
  const ms = performance.now() - started;
  if (!ok) failed += 1;
  rows.push({
    levelId,
    salt,
    ok,
    buses: level.buses.length,
    errors: config.errors,
    replay: sim,
    solvable: diversity.solvable,
    aborted: diversity.aborted,
    solutionCount: diversity.solutionCount,
    openingLegal: diversity.openingLegal,
    openingUnknown: diversity.openingUnknown,
    nodes: diversity.nodes,
    criticalCount: diversity.criticalCount,
    deadlockReachable: diversity.deadlockReachable,
    ms,
  });
  console.log(
    `- 模板 ${String(levelId).padStart(2)} / 种子 ${String(salt).padStart(3)} ${ok ? '✅' : '❌'}`
    + `  车辆 ${level.buses.length} · ${level.grid.cols}×${level.grid.rows}`
    + `  参考解 ${sim.ok ? `${sim.steps} 步` : `失败(${sim.reason})`}`
    + `  可解 ${diversity.solvable ? '是' : '否'}${diversity.aborted ? '(预算不足)' : ''}`
    + `  可行开局 ${diversity.solutionCount}/${diversity.openingLegal}`
    + `  关键步 ${diversity.criticalCount}`
    + `  死局可达 ${diversity.deadlockReachable ? '是' : '否'}`
    + `  ${ms.toFixed(0)}ms`
  );
  for (const e of config.errors) console.log(`    ❌ ${e}`);
}

const pass = rows.filter((r) => r.ok).length;
console.log(`\n结果：${pass}/${rows.length} 个随机种子关卡通过，${failed} 个失败/未确定`);

const header = [
  '| 模板关 | 随机种子 | 结果 | 车辆 | 参考解 | 可解 | 可行开局 | 关键步 | 死局可达 | 搜索节点 | 耗时 |',
  '| ---: | ---: | --- | ---: | --- | --- | ---: | ---: | --- | ---: | ---: |',
];
const body = rows.map((r) => {
  if (!r.ok && r.note) {
    return `| ${r.levelId} | ${r.salt} | ❌ | — | — | — | — | — | — | — | — |`;
  }
  return `| ${r.levelId} | ${r.salt} | ${r.ok ? '✅' : '❌'} | ${r.buses ?? '—'}`
    + ` | ${r.replay?.ok ? `${r.replay.steps} 步` : `失败(${r.replay?.reason ?? '—'})`}`
    + ` | ${r.solvable ? '是' : '否'}${r.aborted ? '（预算不足）' : ''}`
    + ` | ${r.solutionCount ?? '—'}/${r.openingLegal ?? '—'}`
    + ` | ${r.criticalCount ?? '—'}`
    + ` | ${r.deadlockReachable ? '是' : '否'}`
    + ` | ${r.nodes ?? '—'}`
    + ` | ${r.ms == null ? '—' : `${r.ms.toFixed(0)} ms`} |`;
});

fs.writeFileSync(
  new URL('../RANDOM_SEED_STATS.md', import.meta.url),
  `# 随机种子回归统计（由 npm run test:seeds 生成）\n\n`
  + `- 用同一套生成约束、不同 salt（随机种子）生成新关卡，不复用正式 50 关。\n`
  + `- 参考解：与游戏同一套 logic.js 逐步回放是否真实到达 won。\n`
  + `- 可解：有界 DFS 是否找到完整路径；预算不足会标记「预算不足」，不当作无解。\n`
  + `- 可行开局：不同开局点击中能找到完整通关路径的数量 / 开局合法车辆数。\n`
  + `- 关键步：沿首条解法前几步中，只有唯一获胜选择、其余可证明失败的步数。\n`
  + `- 死局可达：搜索中遇到过直接判负的局面；存在不代表关卡无解，只代表有错步陷阱。\n\n`
  + header.join('\n') + '\n' + body.join('\n') + '\n'
);
console.log('已写入 RANDOM_SEED_STATS.md');
process.exitCode = failed === 0 ? 0 : 1;