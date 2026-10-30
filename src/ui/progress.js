/**
 * 关卡进度存档（localStorage，模式与 tutorial.js 的进度持久化一致）。
 * ------------------------------------------------------------
 * 规则：
 *  - 第 1–50 关全部开放，玩家可以自由选择任意关卡；
 *  - clearedMax 只记录「已通关的最大关卡序号」（0 起，-1 = 尚未通关任何关），
 *    用于选关页的通关标记和首页的默认续玩关卡，不再限制进入权限；
 *  - 通关时由 controller.showWin 调用 markLevelCleared 推进进度；
 *  - 只依赖关卡总数（levelRegistry），不触碰游戏状态；
 *  - 无 localStorage 的环境（隐私模式 / Node 测试）自动降级为内存态，
 *    任何读写失败都静默忽略，不影响玩法。
 */
import { getLevelCount } from '../game/levelRegistry.js';

const KEY = 'bus-fever-level-progress-v1';

let clearedMax = -1;

try {
  const v = parseInt(localStorage.getItem(KEY), 10);
  if (Number.isFinite(v)) clearedMax = v;
} catch { /* 无 localStorage：保持内存默认值 */ }

function clampIndex(v) {
  return Math.max(-1, Math.min(v, getLevelCount() - 1));
}

function save() {
  try {
    localStorage.setItem(KEY, String(clearedMax));
  } catch { /* 忽略存储失败 */ }
}

/** 通关一关后调用：通关记录只前进、不回退（不影响关卡进入权限）。 */
export function markLevelCleared(index) {
  if (!Number.isInteger(index)) return;
  if (index > clearedMax) {
    clearedMax = clampIndex(index);
    save();
  }
}

/** 所有关卡均已开放；保留此接口供 UI 与测试统一调用。 */
export function isLevelUnlocked(index) {
  return Number.isInteger(index) && index >= 0 && index < getLevelCount();
}

/** 已通关的最大关卡序号（-1 = 尚未通关任何关）。 */
export function getClearedMax() {
  return clampIndex(clearedMax);
}

/** UI 展示用的进度概要。 */
export function getProgressSummary() {
  const total = getLevelCount();
  return {
    cleared: clampIndex(clearedMax) + 1, // 已通关关数
    total,
    nextIndex: Math.min(clampIndex(clearedMax) + 1, total - 1), // 当前进度所在关
  };
}

/** 调试用：清空通关记录（不会影响关卡开放范围，50 关始终可选）。 */
export function resetProgress() {
  clearedMax = -1;
  save();
}
