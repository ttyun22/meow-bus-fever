/**
 * 控制层：连接核心逻辑与渲染。
 * ------------------------------------------------------------
 * 职责：
 *  - 关卡流程：开始 / 重开 / 下一关 / 全部通关循环；
 *  - 输入处理：点击巴士 -> 校验 -> 原子提交（快照 + 预留接客位）->
 *    并行动画管线 -> 共享结算循环 -> 稳定后统一胜负判定；
 *  - 反馈：被挡摇头 + 挡路车闪烁 + toast 文案 + 事件音效。
 *
 * ---------------- 并行操作模型（取代旧的全局 locked） ----------------
 * 逻辑先行：moveBus 在点击的同一个同步栈内完成状态提交
 * （驶出中 = 已不占棋盘格、已原子预留接客位、moveCount 已计），
 * 因此「同一辆巴士重复处理 / 两辆巴士抢同一接客位」在数据层不可能发生。
 * 动画滞后于状态，以下调度只锁冲突资源、不锁整个游戏：
 *
 *  - activeOps        进行中的「驶出+到位」动画数（巴士状态：驶出中）
 *  - activeExits      正在棋盘上滑出的巴士数；只有它归零才允许
 *                     renderBoard 全量校准（防止驶出动画被 innerHTML 打断）
 *  - inTransit        逻辑上已占接客位、但驶出动画尚未播完的车辆集合；
 *                     接客位对它们显示「驶入中」，避免提前显示已到位
 *  - exitQueue        独立驶出动画队列；连续点击时按提交顺序衔接播放，
 *                     不锁输入、不让两辆车在棋盘上重叠穿越
 *  - pendingArrivals  busId -> Promise，「已分配接客位」的巴士在
 *                     到位动画完成时 resolve；结算循环在播放某车的
 *                     上车/发车动画前会 await 它的到位（视觉与状态一致）
 *  - settleRunning / settlePending
 *                     自动上车/发车结算循环全局单例运行（串行），
 *                     期间收到新请求仅置位合并，结束后统一补跑一轮
 *  - epoch            重开/换关/撤回时递增，所有异步管线携带捕获值，
 *                     过期即静默退出（防止旧动画/旧结算写入新状态）
 *
 * 胜负判定只在「完全稳定点」（activeOps===0 且结算循环空闲）执行一次。
 * 撤回在状态稳定前禁用；恢复快照后同步重放自动结算（settleAll），
 * 保证撤回到的永远是规则闭环的稳定态，而不是半完成动画状态。
 */
import {
  initializeLevel,
  validateMove,
  moveBus,
  boardOnePassenger,
  departReady,
  dispatchWaiting,
  completeArrival,
  completeDeparture,
  settleAll,
  checkWin,
  checkLose,
  loseReason,
  addTemporarySlot,
  extraSlotCount,
  MAX_EXTRA_SLOTS,
  GAME_CONFIG,
} from '../game/logic.js';
import {
  buildSmartHint,
  describeAddSlot,
  describeMoveRisk,
  addReasonText,
} from '../game/hints.js';
import { evaluateMoveRisk, stateKey } from '../game/search.js';
import {
  getLevelByIndex,
  getLevelCount,
  listLevelSummaries,
  validateLevelConfig,
} from '../game/levelRegistry.js';
import { createRenderer, catSvgMarkup } from './render.js';
import {
  playSound,
  unlockAudio,
  isMuted,
  setMuted,
  isBgmMuted,
  setBgmMuted,
  startBgm,
  isBgmPlaying,
  getBgmMode,
} from './sound.js';
import { createTutorial } from './tutorial.js';

const COLOR_NAMES = {
  red: '红色', blue: '蓝色', green: '绿色', purple: '紫色',
  cyan: '青色', orange: '橙色', yellow: '黄色',
};

/**
 * 快速模式（?fast=1）：跳过动画等待，逻辑立即结算到终态。
 * - 对玩家：可作为「跳过动画」偏好；
 * - 对测试：不依赖页面定时器，可在后台/被遮挡窗口中完成自动化验证。
 */
const FAST = new URLSearchParams(location.search).get('fast') === '1';
const sleep = (ms) =>
  FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * 上车动画统一时长：整体提速 1.5 倍（耗时 = 原时长 / 1.5）。
 * 只影响播放节奏，不改匹配规则/载客结算顺序；逻辑上车仍在动画完成前
 * 由 boardOnePassenger 原子提交，因此不会重复上车。
 */
const BOARDING_SPEED = GAME_CONFIG.BOARDING_SPEED;
const BOARD_MOVE_MS = Math.round(360 / BOARDING_SPEED);   // 240ms
const BOARD_SHRINK_MS = Math.round(160 / BOARDING_SPEED); // 107ms
const BOARD_SHRINK_TRANSITION_MS = Math.round(140 / BOARDING_SPEED);

export function createController() {
  const $ = (id) => document.getElementById(id);
  const renderer = createRenderer();

  let levelIndex = 0;
  let level = getLevelByIndex(0);
  let state = null;

  /* ---- 并行调度状态（见文件头注释） ---- */
  let epoch = 0;
  let activeOps = 0;
  let activeExits = 0;
  let settleRunning = false;
  let settlePending = false;
  const pendingArrivals = new Map();
  /** 已点击、尚未完成驶出动画的车辆（逻辑上已 loading，视觉上仍可能停在棋盘）。 */
  const inTransit = new Set();
  /** 独立的驶出动画队列：保证动画连续衔接，但同一时刻不会有两辆车重叠穿越。 */
  let exitQueue = Promise.resolve();

  let pendingRelayout = false;
  let toastTimer = null;
  let areaFlashTimer = null;
  let overlayPrimaryFn = null;
  let overlaySecondaryFn = null;
  let confirmPrimaryFn = null;
  let confirmSecondaryFn = null;

  /** 是否存在未完成的动画/结算（撤回、重排等全局操作的准入条件）。 */
  const isBusy = () => activeOps > 0 || settleRunning;

  /** 换关/重开/撤回：废弃全部在途异步管线并归零计数器。 */
  function bumpEpoch() {
    epoch += 1;
    activeOps = 0;
    activeExits = 0;
    settleRunning = false;
    settlePending = false;
    pendingArrivals.clear();
    inTransit.clear();
    document.querySelectorAll('.walking-cat').forEach((el) => el.remove());
  }

  /**
   * 把一次驶出动画追加到独立队列。前一輛结束后立即开始下一辆，
   * 因此快速连点不会互相穿模，也不会用全局锁阻塞新的合法点击。
   */
  function enqueueExit(task) {
    const run = exitQueue.then(task, task);
    exitQueue = run.catch(() => {});
    return run;
  }

  /* ================= 教学系统 ================= */
  const tutorial = createTutorial({
    getState: () => state,
    resolveTarget(target) {
      if (!state) return null;
      switch (target.type) {
        case 'bus':
          return renderer.getBoardBus(target.id)?.querySelector('.bus-inner') ?? null;
        case 'queue':
          return renderer.getQueueHead();
        case 'slots':
          return $('slots');
        case 'board':
          return $('board');
        case 'rescue':
          return $('btn-rescue');
        case 'restart':
          return $('btn-restart');
        default:
          return null;
      }
    },
    isActionAvailable(name) {
      if (name === 'rescue') {
        return !!state
          && state.status === 'playing'
          && rescueLeft > 0
          && extraSlotCount(state) < MAX_EXTRA_SLOTS
          && !isBusy();
      }
      if (name === 'restart') return !!state;
      return true;
    },
  });

  /* ================= 历史快照 / 加位救援 =================
     撤回入口已从 HUD 移除，但保留 undoStack 作为调试/历史能力
     （window.__game.undo），不影响任何正式玩法与计分。
     正式救援改为「增加临时停车位」：每关 2 次，每次 +1 个接客位，
     最多 +2；必须玩家点击并在确认框中确认后才扣除次数。 */
  let undoStack = [];
  let undoLeft = GAME_CONFIG.UNDO_LIMIT;
  let rescueLeft = GAME_CONFIG.RESCUE_LIMIT;
  /** 防止同一帧内连点造成一次加位被重复扣除。 */
  let rescueLock = false;
  /** 操作风险分析缓存（state 键 + busId -> 结论），限制容量避免泄漏。 */
  let riskCache = new Map();
  /** 当前智能提示与「同状态不重复展示」去重记录。 */
  let currentHint = null;
  let lastHintShownKey = '';
  let lastHintShownText = '';
  let lastToastHintKey = '';
  let lastToastHintText = '';
  let hintRefreshTimer = null;

  function resetUndo() {
    undoStack = [];
    undoLeft = GAME_CONFIG.UNDO_LIMIT;
    rescueLeft = GAME_CONFIG.RESCUE_LIMIT;
    rescueLock = false;
    riskCache = new Map();
    lastHintShownKey = '';
    lastHintShownText = '';
    lastToastHintKey = '';
    lastToastHintText = '';
    currentHint = null;
    updateControlButtons();
  }

  /** 加位按钮的文案、可用状态与原因提示（唯一入口，避免状态不一致）。 */
  function updateControlButtons() {
    const btn = $('btn-rescue');
    if (!btn) return;
    const extra = state ? extraSlotCount(state) : 0;
    const canPress = !!state
      && state.status !== 'won'
      && rescueLeft > 0
      && extra < MAX_EXTRA_SLOTS
      && !isBusy();
    btn.textContent = `加位 ${rescueLeft}`;
    btn.disabled = !canPress;
    if (!state) {
      btn.title = '进入关卡后可以增加临时停车位';
    } else if (state.status === 'won') {
      btn.title = '本关已经完成';
    } else if (rescueLeft <= 0) {
      btn.title = '本关的 2 次加位已经用完';
    } else if (extra >= MAX_EXTRA_SLOTS) {
      btn.title = `临时车位已到上限（最多额外 ${MAX_EXTRA_SLOTS} 个）`;
    } else {
      const why = describeAddSlot(state, rescueLeft);
      btn.title = `${why.text}（剩余 ${rescueLeft} 次，本关最多额外 +${MAX_EXTRA_SLOTS}）`;
    }
  }

  /** 历史/调试用撤回：不占用 HUD 入口，也不影响正式救援次数。 */
  function undo() {
    if (!state) return;
    if (isBusy()) return;
    if (undoLeft <= 0) { playSound('illegal'); toast('调试撤回次数已用完。'); return; }
    if (undoStack.length === 0) { playSound('illegal'); toast('没有可撤回的操作。'); return; }
    bumpEpoch();
    state = undoStack.pop();
    undoLeft -= 1;
    settleAll(state);
    hideOverlay();
    hideConfirm();
    renderer.renderAll(state, level);
    tutorial.refresh();
    refreshHint(true);
    if (checkWin(state)) showWin();
    else if (checkLose(state)) showLose();
    else { playSound('undo'); toast('已撤回到上一步'); }
    updateControlButtons();
  }

  /** 点击「加位」：先展示真实效果与剩余次数，确认后才扣除。 */
  function requestAddSlot() {
    if (!state || isBusy() || rescueLock) return;
    if (state.status === 'won') return;
    if (rescueLeft <= 0) {
      playSound('illegal');
      toast('本关的 2 次加位已经用完了，可以「重开」重置。');
      return;
    }
    if (extraSlotCount(state) >= MAX_EXTRA_SLOTS) {
      playSound('illegal');
      toast(`临时车位已到上限（最多额外 ${MAX_EXTRA_SLOTS} 个）。`);
      return;
    }
    const info = describeAddSlot(state, rescueLeft);
    const warn = info.usable ? '' : '\n注意：当前局面下，这个临时位可能无法立刻派上用场。';
    showConfirm({
      icon: '🅿️',
      title: '增加临时停车位',
      text: `将在接客位右侧增加 1 个临时车位，本关已增加 ${extraSlotCount(state)}/${MAX_EXTRA_SLOTS} 个。\n${info.text}${warn}\n剩余次数：${rescueLeft} 次 → ${rescueLeft - 1} 次`,
      primaryLabel: info.usable ? '确认增加' : '仍然增加',
      secondaryLabel: '再想想',
      onPrimary: performAddSlot,
      onSecondary: hideConfirm,
    });
  }

  /** 确认后执行：只增加 1 个接客位，成功才扣 1 次。 */
  function performAddSlot() {
    if (!state || rescueLock) return;
    rescueLock = true;
    const res = addTemporarySlot(state, rescueLeft);
    if (!res.ok) {
      rescueLock = false;
      hideConfirm();
      playSound('illegal');
      toast(addReasonText(res) || '现在无法增加临时车位。');
      updateControlButtons();
      return;
    }
    rescueLeft = res.slotLeft;
    hideConfirm();
    hideOverlay();
    playSound('undo');
    renderer.renderAll(state, level);
    tutorial.notify('add-slot', { slotIndex: res.slotIndex });
    tutorial.refresh();
    updateControlButtons();
    refreshHint(true);
    toast(`已增加 1 个临时接客位（共 ${res.slotCount} 个），剩余加位 ${rescueLeft} 次。`, 2600);
    requestSettle(); // 让等待车辆/已有车辆立刻使用新位置
    setTimeout(() => { rescueLock = false; }, 260);
  }

  /* ================= 关卡流程 ================= */

  function startLevel(i) {
    const cfg = getLevelByIndex(i);
    if (!cfg) {
      showLevelError(`关卡 ${i + 1} 不存在（当前共 ${getLevelCount()} 关）。`);
      return;
    }
    const v = validateLevelConfig(cfg);
    if (!v.ok) {
      showLevelError(`第 ${cfg.id} 关配置不合法：\n${v.errors.join('\n')}`);
      return;
    }
    levelIndex = i;
    level = cfg;
    bumpEpoch();
    state = initializeLevel(level);
    pendingRelayout = false;
    hideOverlay();
    hideConfirm();
    resetUndo(); // 进入新关卡：加位次数重置为 2，历史快照不沿用上一关
    $('screen-start').classList.add('hidden');
    $('screen-levels').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
    renderer.renderAll(state, level);
    refreshHint(true);
    tutorial.startFor(level.id);
  }

  /** 关卡配置缺失/不合法：给出明确错误，而不是空白页。 */
  function showLevelError(detail) {
    bumpEpoch();
    state = null;
    hideOverlay();
    hideConfirm();
    $('screen-game').classList.remove('hidden');
    $('screen-start').classList.add('hidden');
    showOverlay({
      icon: '⚠️',
      title: '关卡加载失败',
      text: detail,
      primary: { label: '回到首页', fn: backToStart },
      secondary: null,
    });
  }

  function backToStart() {
    bumpEpoch();
    state = null;
    hideOverlay();
    hideConfirm();
    tutorial.stop();
    $('screen-game').classList.add('hidden');
    $('screen-levels').classList.add('hidden');
    $('screen-start').classList.remove('hidden');
  }

  /* ================= 选关页 =================
     从开始页或游戏内（HUD 关卡名）打开；从游戏内打开时不打断
     当前对局——不选直接返回则原样继续，选定关卡才 startLevel 重建。 */
  let levelsFrom = 'start';

  function showLevelSelect(from) {
    if (from === 'game' && !state) from = 'start'; // 防御：无对局时回首页
    levelsFrom = from;
    tutorial.stop(); // 选关页不显示教学气泡；返回对局时按进度恢复
    renderer.renderLevelSelect(listLevelSummaries(), state ? levelIndex : -1);
    $('screen-start').classList.add('hidden');
    $('screen-game').classList.add('hidden');
    $('screen-levels').classList.remove('hidden');
  }

  function hideLevelSelect() {
    $('screen-levels').classList.add('hidden');
    if (levelsFrom === 'game' && state) {
      $('screen-game').classList.remove('hidden');
      // 选关页期间视口可能变化；等一帧让 flex 布局落定后重算棋盘
      const st = state;
      const lv = level;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (state !== st || level !== lv) return;
        if ($('screen-game').classList.contains('hidden')) return;
        if (isBusy()) { pendingRelayout = true; return; }
        renderer.renderAll(st, lv);
        tutorial.startFor(lv.id); // 从选关页返回：按已有进度恢复教学
        refreshHint(true);
      }));
    } else {
      $('screen-start').classList.remove('hidden');
    }
  }

  /** 重新开始当前关卡（不刷新页面，重建全新 state）。 */
  function restartLevel() {
    // 先结束「重开」教学步骤：重开本身是玩家已经完成的动作。
    tutorial.notify('restart', { levelId: level.id });
    bumpEpoch();
    state = initializeLevel(level);
    pendingRelayout = false;
    hideOverlay();
    hideConfirm();
    resetUndo(); // 重开 = 重建干净的初始状态（加位次数恢复为 2）
    renderer.renderAll(state, level);
    refreshHint(true);
    tutorial.startFor(level.id); // 已掌握的教学不会重复弹出
    toast('本关已重置，加位次数恢复为 2 次');
  }

  /** 进入下一关（最后一关之后回到第 1 关，形成完整循环）。 */
  function loadNextLevel() {
    if (levelIndex >= getLevelCount() - 1) startLevel(0);
    else startLevel(levelIndex + 1);
  }

  /* ================= 操作风险分析（提示系统） =================
     用与游戏完全一致的规则做有界搜索。只缓存结论、不修改 state；
     预算耗尽时返回 unknown，界面不会据此禁止合法操作。 */
  function getMoveRisk(busId) {
    if (!state) return { level: 'unknown', reason: 'no-state' };
    const key = `${stateKey(state)}|${busId}`;
    if (riskCache.has(key)) return riskCache.get(key);
    const risk = evaluateMoveRisk(state, busId, { maxNodes: 8_000 });
    if (riskCache.size > 160) riskCache.delete(riskCache.keys().next().value);
    riskCache.set(key, risk);
    return risk;
  }

/* ================= 点击巴士（并行入口） =================
     校验与提交在同一个同步栈内完成（无 await），因此多次快速点击的
     提交顺序 = 点击顺序，接客位预留原子生效，不存在竞态。 */
  function onBusClick(busId, opts = {}) {
    if (!state) return;
    // 已胜利/失败：覆盖层已给出结论，轻提示即可（覆盖层背景不拦截，
    // 玩家仍可从 HUD 重开或进入下一关）
    if (state.status !== 'playing') {
      toast('本局已结束，请重开或进入下一关。', 1600);
      return;
    }
    const bus = state.buses[busId];
    // 同一辆巴士不可重复处理：驶出提交后 status 立即变为 moving/loading/waiting，
    // 动画期间的重复点击在此被忽略（不再使用全局输入锁）
    if (!bus) return;
    if (bus.status === 'waiting') {
      toast('这辆车已排队等待接客位，空位出现后会自动进入。', 1800);
      return;
    }
    if (bus.status !== 'board') return;

    // 先校验（只读）：路径阻挡；满位时允许进入等待队列
    const check = validateMove(state, busId);
    if (!check.ok) {
      handleIllegalMove(busId, check);
      return;
    }

    // 只对「可证明会失去所有通关路径」的操作做确认提醒；搜索预算不足
    // 时绝不阻止玩家，也不使用「必然堵死」的措辞。
    if (!opts.skipRisk && !isBusy()) {
      const risk = getMoveRisk(busId);
      if (risk.level === 'proven') {
        showConfirm({
          icon: '⚠️',
          title: '这一步会堵死',
          text: describeMoveRisk(state, busId, risk),
          primaryLabel: '仍然移动',
          secondaryLabel: '先不动',
          onPrimary: () => {
            hideConfirm();
            onBusClick(busId, { skipRisk: true });
          },
          onSecondary: hideConfirm,
        });
        return;
      }
    }

    // 原子提交：操作前快照 -> moveBus 同步完成驶出/预留接客位/排队
    undoStack.push(structuredClone(state)); // 仅调试历史，不占用玩法入口
    if (undoStack.length > 30) undoStack.shift();
    const res = moveBus(state, busId);
    if (!res.ok) {
      undoStack.pop(); // 理论不可达（已 validate），防御：不留无主快照
      return;
    }
    if (res.queued) {
      handleQueuedBus(busId);
      return;
    }
    commitOp(busId, res.events);
  }

  /** 满位时点击合法车辆：加入等待队列，不占接客位，也不锁死输入。 */
  function handleQueuedBus(busId) {
    renderer.markBusWaiting(busId);
    renderer.renderHud(state, level);
    renderer.renderSlots(state, { inTransit });
    updateControlButtons();
    playSound('click');
    toast(`接客位已满，已加入等待队列（第 ${state.waiting.length} 辆）`, 2000);
    scheduleHintRefresh();
    // 队首巴士若刚被排队，不产生动画请求；空位出现时由结算循环派车。
    requestSettle();
  }

  /** 提交一次驶出：登记并行资源，启动该车的独立动画管线（不阻塞输入）。 */
  function commitOp(busId, events) {
    const st = state;
    const ep = epoch;
    activeOps += 1;
    inTransit.add(busId);
    renderer.markBusProcessing(busId);
    updateControlButtons(); // 稳定前禁用加位
    renderer.clearPathPreview();
    renderer.renderHud(st, level);
    scheduleHintRefresh();
    tutorial.notify('exit', { busId });

    // 「已分配接客位」的到位承诺：结算循环播放该车动画前会等待它
    let arriveResolve;
    pendingArrivals.set(busId, new Promise((r) => { arriveResolve = r; }));
    runOp(st, ep, busId, events, arriveResolve); // 不 await：与其他巴士并行
  }

  /** 单辆巴士的动画管线：排队驶出棋盘 -> 到位接客位 -> 请求共享结算。 */
  async function runOp(st, ep, busId, events, arriveResolve) {
    try {
      activeExits += 1;
      for (const ev of events) {
        if (ev.type !== 'exit') continue;
        await enqueueExit(async () => {
          if (st !== state || ep !== epoch) return;
          await animateExit(ev);
        });
        if (st !== state || ep !== epoch) return; // 状态已易主：静默退出
      }
      inTransit.delete(busId);
      activeExits -= 1;
      // 棋盘全量校准只在没有任何驶出动画时进行（防止 innerHTML 打断并行动画），
      // 同时刷新其他巴士的「可驶出」箭头
      if (activeExits === 0) {
        renderer.renderBoard(st);
        tutorial.refresh();
      }
      // 到位：该车在接客位可见（仍在途的车显示为「驶入中」，不会提前占位显示）
      renderer.renderSlots(st, { pop: busId, inTransit });
      tutorial.refresh();
      await sleep(300);
      if (st !== state || ep !== epoch) return;
      // 动画到位后才允许上车：moving -> loading 是唯一的到位入口。
      completeArrival(st, busId);
      pendingArrivals.delete(busId);
      arriveResolve();
      tutorial.notify('arrive', { busId });
      tutorial.refresh();
      requestSettle();
    } finally {
      if (ep === epoch) {
        activeOps -= 1;
        maybeFinish();
      }
    }
  }

  /** 触屏上高密度关卡的单格很小：点到车旁的空隙时，吸附到最近的车。 */
  function nearestBusId(clientX, clientY) {
    const rect = renderer.boardEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const threshold = Math.max(10, renderer.getCellSize() * 0.65);
    let bestId = null;
    let bestDist = Infinity;
    for (const el of renderer.boardEl.querySelectorAll('.bus')) {
      const left = el.offsetLeft;
      const top = el.offsetTop;
      const right = left + el.offsetWidth;
      const bottom = top + el.offsetHeight;
      const dx = Math.max(left - x, 0, x - right);
      const dy = Math.max(top - y, 0, y - bottom);
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = el.dataset.busId;
      }
    }
    return bestDist <= threshold ? bestId : null;
  }

  function handleIllegalMove(busId, res) {
    playSound('illegal');
    if (res.reason === 'blocked') {
      const busEl = renderer.getBoardBus(busId);
      const blocker = state.buses[res.blockerId];
      // 闪烁框贴合车身本体（.bus-inner），指向真实挡路车辆
      const blockerInner = busEl && busEl.dataset.busId === res.blockerId
        ? busEl.querySelector('.bus-inner')
        : renderer.getBoardBus(res.blockerId)?.querySelector('.bus-inner');
      if (busEl) {
        busEl.classList.remove('anim-shake');
        void busEl.offsetWidth; // 重启动画
        busEl.classList.add('anim-shake');
        setTimeout(() => busEl.classList.remove('anim-shake'), 500);
      }
      if (blockerInner) {
        blockerInner.classList.remove('anim-flash');
        void blockerInner.offsetWidth;
        blockerInner.classList.add('anim-flash');
        setTimeout(() => blockerInner.classList.remove('anim-flash'), 1000);
      }
      toast(`前方被挡住了！先移开${COLOR_NAMES[blocker?.color] || ''}巴士。`);
      tutorial.notify('blocked', { busId, blockerId: res.blockerId });
    } else if (res.reason === 'no-slot') {
      toast('接客位已满，请先让已有巴士发车。');
      flashSlotsArea();
    }
  }

  /** 接客位区域短暂高亮（提示空间瓶颈），结束后自动清理。 */
  function flashSlotsArea() {
    const area = $('slots-area');
    if (!area) return;
    area.classList.remove('anim-area-flash');
    void area.offsetWidth;
    area.classList.add('anim-area-flash');
    clearTimeout(areaFlashTimer);
    areaFlashTimer = setTimeout(() => area.classList.remove('anim-area-flash'), 950);
  }

  /* ================= 共享结算循环 =================
     自动上车/发车会改写队列与全部接客位，属于全局共享资源：
     任意时刻只允许一个结算循环运行；运行期间的新请求合并为
     settlePending，由运行中的循环补跑。 */
  function requestSettle() {
    settlePending = true;
    if (settleRunning) return;
    settleRunning = true;
    updateControlButtons();
    const st = state;
    const ep = epoch;
    (async () => {
      try {
        while (settlePending) {
          settlePending = false;
          await runSettle(st, ep);
          if (st !== state || ep !== epoch) return;
        }
      } finally {
        if (ep === epoch) {
          settleRunning = false;
          settlePending = false;
          maybeFinish();
        }
      }
    })();
  }

  /** 等待某辆巴士完成到位动画（并行期保护：乘客只飞向已在位的车）。 */
  async function waitArrival(busId) {
    const p = pendingArrivals.get(busId);
    if (p) await p;
  }

  async function runSettle(st, ep) {
    for (;;) {
      if (st !== state || ep !== epoch) return;

      // 逐个乘客结算：状态与画面始终一一对应，计数不会提前跳变。
      // 队首猫先漂浮到「队列 → 接客位车门」，走到车门后才更新载客数。
      const headEl = renderer.getQueueHead();
      const fromRect = headEl ? headEl.getBoundingClientRect() : null;
      const ev = boardOnePassenger(st);
      if (ev) {
        await waitArrival(ev.busId);
        if (st !== state || ep !== epoch) return;
        playSound('board');
        tutorial.notify('board', { busId: ev.busId, color: ev.color });
        renderer.renderQueue(st);          // 后方猫咪补位
        await animateBoard(st, ev, fromRect);
        if (st !== state || ep !== epoch) return;
        renderer.renderSlots(st, { inTransit }); // 猫进车门后才刷新 1/3 计数
        renderer.bumpSlotBus(ev.busId);
        tutorial.refresh();
        scheduleHintRefresh();
      }

      // 关键规则：任意一辆车「刚达到自身容量」就立刻结算离场并释放车位，
      // 不等待其他仍在慢速上客的车辆。departReady 会一次性处理所有已满足
      // 发车条件的车（满载，或该颜色队列已空），每辆车只会离开一次。
      const departEvs = departReady(st);
      for (const d of departEvs) {
        // 满员/同色接完即离场：逻辑已发车，教学先于离场动画收尾。
        tutorial.notify('depart', { busId: d.busId });
        await waitArrival(d.busId);
        if (st !== state || ep !== epoch) return;
        await animateDepart(st, d);
        if (st !== state || ep !== epoch) return;
        // 动画结束才标 completed；绝不再释放接客位（车位可能已被新车占用）。
        completeDeparture(st, d.busId);
      }
      if (departEvs.length > 0) {
        renderer.renderSlots(st, { inTransit });
        scheduleHintRefresh();
      }

      // 车位释放后按等待顺序处理车辆：不占位、不抢位，逐辆原子分配；
// 队首若被其他车阵挡住，会先派第一辆可通行车辆，避免等待队列自我锁死。
      const dispatchEvs = dispatchWaiting(st);
      for (const d of dispatchEvs) {
        // 复用点击驶出的动画管线（逻辑上已 moving 并预留接客位）。
        commitOp(d.busId, [{ type: 'exit', busId: d.busId, dir: d.dir, fromX: d.fromX, fromY: d.fromY }]);
      }
      if (dispatchEvs.length > 0) renderer.renderSlots(st, { inTransit });

      if (!ev && departEvs.length === 0 && dispatchEvs.length === 0) break;
    }
  }

  /* ================= 稳定点：胜负判定 =================
     只在「无任何在途动画且结算循环空闲」时执行；checkWin/checkLose
     同步翻转 status，天然保证只触发一次。 */
  function maybeFinish() {
    updateControlButtons();
    const st = state;
    const ep = epoch;
    if (!st || st.status !== 'playing') return;
    if (activeOps > 0 || settleRunning) return;
    if (checkWin(st)) {
      refreshHint(true);
      sleep(320).then(() => {
        if (st === state && ep === epoch) showWin();
      });
      return;
    }
    if (checkLose(st)) {
      refreshHint(true);
      sleep(320).then(() => {
        if (st === state && ep === epoch) showLose();
      });
      return;
    }
    refreshHint();
    tutorial.refresh();
    if (pendingRelayout) {
      pendingRelayout = false;
      if (!$('screen-game').classList.contains('hidden')) {
        renderer.renderAll(st, level);
        tutorial.refresh();
      }
    }
  }

  /* ================= 结算动画 ================= */

  /** 巴士驶出停车场：沿朝向滑出棋盘。 */
  async function animateExit(ev) {
    const el = renderer.getBoardBus(ev.busId);
    if (!el) return;
    el.classList.remove('is-queued');
    const w = renderer.boardEl.clientWidth;
    const h = renderer.boardEl.clientHeight;
    const dist = {
      right: `translate(${w + 40}px, 0)`,
      left: `translate(${-w - 40}px, 0)`,
      down: `translate(0, ${h + 40}px)`,
      up: `translate(0, ${-h - 40}px)`,
    }[ev.dir];
    el.classList.add('anim-exit');
    el.style.transform = dist;
    await sleep(430);
    el.remove();
  }

  /** 队首猫头沿地面漂浮到接客位巴士的车门，再弹跳缩小钻入车内。 */
  async function animateBoard(st, ev, fromRect) {
    const slotBusEl = renderer.getSlotBus(ev.busId);
    if (!slotBusEl || !fromRect) {
      renderer.renderSlots(st, { inTransit });
      renderer.bumpSlotBus(ev.busId);
      await sleep(Math.round(180 / BOARDING_SPEED));
      return;
    }
    const to = slotBusEl.getBoundingClientRect();
    const cat = document.createElement('div');
    cat.className = `walking-cat c-${ev.color}`;
    cat.style.width = `${fromRect.width}px`;
    cat.style.height = `${fromRect.height}px`;
    cat.style.left = `${fromRect.left}px`;
    cat.style.top = `${fromRect.top}px`;
    // 行驶段统一使用提速后的时长，保证状态结算与动画节奏一致。
    cat.style.transition =
      `left ${BOARD_MOVE_MS}ms cubic-bezier(.3,.7,.4,1), ` +
      `top ${BOARD_MOVE_MS}ms cubic-bezier(.3,.7,.4,1), ` +
      `transform ${BOARD_MOVE_MS}ms cubic-bezier(.3,.7,.4,1)`;
    cat.innerHTML = catSvgMarkup({ walking: true });
    document.body.appendChild(cat);
    void cat.offsetWidth;
    // 漂浮到车门前：略微偏向车头侧，悬起一点，随后弹跳缩小钻入
    const targetW = fromRect.width;
    const targetH = fromRect.height;
    const doorX = to.left + to.width * 0.56 - targetW / 2;
    const doorY = to.top + to.height * 0.48 - targetH / 2;
    cat.style.left = `${doorX}px`;
    cat.style.top = `${doorY}px`;
    cat.style.transform = 'translateY(-7px) scale(1.04)';
    await sleep(BOARD_MOVE_MS);
    // 到车门后快速缩小钻入（避免乘客在车外停留过久）
    cat.style.transition =
      `transform ${BOARD_SHRINK_TRANSITION_MS}ms ease-in, opacity ${BOARD_SHRINK_TRANSITION_MS}ms ease-in`;
    cat.style.transform = 'translateY(-2px) scale(.2) rotate(6deg)';
    cat.style.opacity = '0';
    await sleep(BOARD_SHRINK_MS);
    cat.remove();
  }

  /** 满载巴士从接客位发车离场。 */
  async function animateDepart(st, ev) {
    const el = renderer.getSlotBus(ev.busId);
    if (!el) {
      renderer.renderSlots(st, { inTransit });
      await sleep(200);
      return;
    }
    el.classList.add('anim-depart');
    el.style.transform = 'translateX(150%)';
    el.style.opacity = '0';
    await sleep(460);
    // 并行期间该接客位可能已分配给新巴士：renderSlots 按当前 state
    // 全量重建，与新车的到位渲染天然兼容
    renderer.renderSlots(st, { inTransit });
  }

  /* ================= 胜负覆盖层 ================= */

  function showOverlay({ icon, title, text, primary, secondary }) {
    $('overlay-icon').textContent = icon;
    $('overlay-title').textContent = title;
    $('overlay-text').textContent = text;
    const btnP = $('btn-overlay-primary');
    const btnS = $('btn-overlay-secondary');
    btnP.textContent = primary.label;
    overlayPrimaryFn = primary.fn;
    if (secondary) {
      btnS.classList.remove('hidden');
      btnS.textContent = secondary.label;
      overlaySecondaryFn = secondary.fn;
    } else {
      btnS.classList.add('hidden');
      overlaySecondaryFn = null;
    }
    $('overlay').classList.remove('hidden');
  }

  function hideOverlay() {
    $('overlay').classList.add('hidden');
    overlayPrimaryFn = null;
    overlaySecondaryFn = null;
  }

  /* ---------- 通用确认框：加位确认 / 死局风险提醒 ---------- */
  function showConfirm({ icon = '❓', title, text, primaryLabel, secondaryLabel, onPrimary, onSecondary }) {
    const el = $('confirm');
    if (!el) return;
    $('confirm-icon').textContent = icon;
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('btn-confirm-primary').textContent = primaryLabel;
    $('btn-confirm-secondary').textContent = secondaryLabel;
    confirmPrimaryFn = onPrimary;
    confirmSecondaryFn = onSecondary;
    el.classList.remove('hidden');
  }

  function hideConfirm() {
    const el = $('confirm');
    if (el) el.classList.add('hidden');
    confirmPrimaryFn = null;
    confirmSecondaryFn = null;
  }

  /* ---------- 智能提示 ---------- */
  function renderHintBar(hint, { pulse = false } = {}) {
    const bar = $('smart-hint');
    const textEl = $('smart-hint-text');
    if (!bar || !textEl) return;
    if (!hint) {
      bar.classList.add('hidden');
      return;
    }
    textEl.textContent = hint.text;
    bar.dataset.kind = hint.kind || 'info';
    bar.classList.remove('hidden');
    if (pulse) {
      bar.classList.remove('hint-pulse');
      void bar.offsetWidth;
      bar.classList.add('hint-pulse');
    }
  }

  /** 重新读取最新 state 并更新提示条；同一状态相同文案不重复刷新。 */
  function refreshHint(force = false) {
    if (!state) return;
    if ($('screen-game').classList.contains('hidden')) return;
    const hint = buildSmartHint(state, { rescueLeft });
    currentHint = hint;
    const same = hint.key === lastHintShownKey && hint.text === lastHintShownText;
    if (!same || force) {
      renderHintBar(hint, { pulse: !same });
      lastHintShownKey = hint.key;
      lastHintShownText = hint.text;
    }
  }

  /** 合并短时间内的多次状态变化（上车/离站/加位），避免动画期间频繁重算。 */
  function scheduleHintRefresh() {
    clearTimeout(hintRefreshTimer);
    hintRefreshTimer = setTimeout(() => {
      hintRefreshTimer = null;
      refreshHint();
    }, 120);
  }

  /** 「提示」按钮：给出可立即执行的动作；同一状态不重复弹完全相同的长文案。 */
  function showHint() {
    if (!state) return;
    refreshHint();
    const hint = currentHint;
    if (!hint) return;
    if (hint.busId) renderer.pulseBus(hint.busId);
    if (hint.key === lastToastHintKey && hint.text === lastToastHintText) {
      renderHintBar(hint, { pulse: true });
      toast('当前局面没有变化，建议仍是上方这条提示。', 1800);
      return;
    }
    lastToastHintKey = hint.key;
    lastToastHintText = hint.text;
    toast(hint.text, Math.min(6500, Math.max(3000, hint.text.length * 90)));
  }

  function showWin() {
    playSound('win');
    tutorial.completeLevel(level.id); // 通关即「已掌握」本关教学，永不再弹
    updateControlButtons();
    const isLast = levelIndex >= getLevelCount() - 1;
    const par = level.solution.par;
    const perfect = state.moveCount <= par;
    const text = isLast
      ? `🎉 你通关了全部 ${getLevelCount()} 关！\n本关操作 ${state.moveCount} 次（参考 ${par} 次）${perfect ? '，达到最优解！' : ''}`
      : `送完了所有乘客！\n本关操作 ${state.moveCount} 次（参考 ${par} 次）${perfect ? '，达到最优解！' : ''}`;
    showOverlay({
      icon: isLast ? '🏆' : '🎉',
      title: isLast ? '全部通关！' : '通关！',
      text,
      primary: { label: isLast ? '再来一轮' : '下一关', fn: loadNextLevel },
      secondary: { label: '再玩本关', fn: restartLevel },
    });
  }

  function showLose() {
    playSound('lose');
    updateControlButtons();
    const addInfo = describeAddSlot(state, rescueLeft);
    const canAdd = rescueLeft > 0
      && extraSlotCount(state) < MAX_EXTRA_SLOTS
      && addInfo.usable;
    showOverlay({
      icon: '😵',
      title: '堵死了！',
      text: `${loseReason(state)}\n${addInfo.text}`,
      primary: canAdd
        ? { label: '增加停车位', fn: requestAddSlot }
        : { label: '重试本关', fn: restartLevel },
      secondary: canAdd
        ? { label: '重开本关', fn: restartLevel }
        : { label: '查看提示', fn: showHint },
    });
    refreshHint(true);
    tutorial.refresh();
  }

  /* ================= 杂项 ================= */

  function toast(msg, ms = 2000) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function updateMuteBtn() {
    const btn = $('btn-mute');
    if (!btn) return;
    btn.textContent = isMuted() ? '🔇' : '🔊';
    btn.title = isMuted() ? '音效已静音，点击开启' : '音效开启中，点击静音';
  }

  /** BGM 独立开关：首页与游戏内共用同一状态，关闭后 SFX 保持正常。 */
  function updateMusicButtons() {
    const muted = isBgmMuted();
    const btn = $('btn-music');
    if (btn) {
      btn.title = muted ? '背景音乐已关闭，点击开启' : '背景音乐开启中，点击关闭';
      btn.classList.toggle('is-off', muted);
      btn.setAttribute('aria-pressed', String(!muted));
      btn.setAttribute('aria-label', muted ? '背景音乐已关闭，点击开启' : '背景音乐开启中，点击关闭');
    }
    const home = $('btn-music-home');
    if (home) {
      home.title = muted ? '背景音乐已关闭，点击开启' : '背景音乐开启中，点击关闭';
      home.classList.toggle('is-off', muted);
      home.setAttribute('aria-pressed', String(!muted));
    }
    const label = $('music-home-label');
    if (label) label.textContent = muted ? '音乐关闭' : '音乐开启';
  }

  /** 首页 / 游戏内音乐开关的共同入口：真实停止或恢复 BGM。 */
  function toggleMusic() {
    const nextMuted = !isBgmMuted();
    if (!nextMuted) {
      // 用户主动点击 = 合法手势：解锁并恢复播放。
      unlockAudio(false);
      startBgm();
    }
    setBgmMuted(nextMuted);
    updateMusicButtons();
    playSound('click');
  }

  /* ================= 视口 / 重排 =================
     手机竖屏下浏览器地址栏收起、旋转、软键盘或安全区变化都会改变
     可视高度；用 visualViewport + ResizeObserver 统一触发重排，
     只重算布局，不改任何游戏状态/移动规则。 */
  let relayoutRaf = null;

  function syncViewportHeight() {
    const vv = window.visualViewport;
    const h = Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight);
    if (h > 0) document.documentElement.style.setProperty('--app-height', `${h}px`);
  }

  function scheduleRelayout() {
    if (!state) return;
    if ($('screen-game').classList.contains('hidden')) {
      pendingRelayout = true;
      return;
    }
    if (relayoutRaf) return;
    relayoutRaf = requestAnimationFrame(() => {
      relayoutRaf = null;
      if (!state) return;
      if ($('screen-game').classList.contains('hidden')) {
        pendingRelayout = true;
        return;
      }
      if (isBusy()) { pendingRelayout = true; return; }
      renderer.renderAll(state, level);
      tutorial.refresh();
      refreshHint(true);
    });
  }

  /* ================= 初始化 ================= */

  function init() {
    // 浏览器自动播放策略：首次用户手势只解锁 AudioContext；
    // 真正的 BGM 由「开始游戏」或音乐开关在用户手势中启动。
    window.addEventListener('pointerdown', () => unlockAudio(false));

    $('btn-start').addEventListener('click', () => {
      playSound('click');
      unlockAudio(false);
      startBgm();
      startLevel(0);
    });
    $('btn-levels')?.addEventListener('click', () => { playSound('click'); showLevelSelect('start'); });
    $('btn-levels-back').addEventListener('click', () => { playSound('click'); hideLevelSelect(); });
    $('hud-level').addEventListener('click', () => { playSound('click'); showLevelSelect('game'); });
    $('level-grid').addEventListener('click', (e) => {
      const cell = e.target.closest('.level-cell');
      if (!cell) return;
      playSound('click');
      startLevel(Number(cell.dataset.levelIndex)); // 选关即跳转（含重玩当前关）
    });
    $('btn-restart').addEventListener('click', () => { playSound('click'); restartLevel(); });
    $('btn-rescue').addEventListener('click', () => { playSound('click'); requestAddSlot(); });
    $('btn-hint').addEventListener('click', () => {
      playSound('click');
      showHint();
    });
    $('btn-mute').addEventListener('click', () => {
      setMuted(!isMuted());
      updateMuteBtn();
      playSound('click'); // 静音后无声、解除静音立即有声，即所得反馈
    });
    $('btn-music').addEventListener('click', toggleMusic);
    $('btn-music-home').addEventListener('click', toggleMusic);
    $('btn-overlay-primary').addEventListener('click', () => { playSound('click'); overlayPrimaryFn?.(); });
    $('btn-overlay-secondary').addEventListener('click', () => { playSound('click'); overlaySecondaryFn?.(); });
    $('btn-confirm-primary').addEventListener('click', () => { playSound('click'); confirmPrimaryFn?.(); });
    $('btn-confirm-secondary').addEventListener('click', () => { playSound('click'); confirmSecondaryFn?.(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideConfirm(); });
    updateMuteBtn();
    updateMusicButtons();

    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
    renderer.boardEl.addEventListener('click', (e) => {
      const busEl = e.target.closest('.bus');
      if (busEl) {
        onBusClick(busEl.dataset.busId);
        return;
      }
      // 手机高密度关：车位格子较小，点击车旁一点点也能命中最近车辆。
      if (!coarsePointer) return;
      const id = nearestBusId(e.clientX, e.clientY);
      if (id) onBusClick(id);
    });

    // 驶出路径预览：仅在有 hover 能力的设备上启用（桌面鼠标）；
    // 触屏点击即驶出，被挡反馈（摇头+闪烁）已承担提示职责
    if (window.matchMedia?.('(hover: hover)').matches) {
      renderer.boardEl.addEventListener('mouseover', (e) => {
        const busEl = e.target.closest('.bus');
        if (busEl) renderer.showPathPreview(state, busEl.dataset.busId);
      });
      renderer.boardEl.addEventListener('mouseout', (e) => {
        const from = e.target.closest('.bus');
        if (from && from !== e.relatedTarget?.closest?.('.bus')) {
          renderer.clearPathPreview();
        }
      });
      renderer.boardEl.addEventListener('mouseleave', () => renderer.clearPathPreview());
    }

    syncViewportHeight();
    const onViewportChange = () => {
      syncViewportHeight();
      scheduleRelayout();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 120));
    window.visualViewport?.addEventListener('resize', onViewportChange);
    window.visualViewport?.addEventListener('scroll', onViewportChange);
    if (typeof ResizeObserver === 'function') {
      // 安全区/地址栏/旋转导致容器尺寸变化时，重算棋盘 cell 与队列可见数量。
      const ro = new ResizeObserver(scheduleRelayout);
      ro.observe($('screen-game'));
      ro.observe($('board-wrap'));
    }

    // 自动化测试 / 调试句柄（startLevel 供验证关卡错误提示路径）
    window.__game = {
      get state() { return state; },
      get level() { return level; },
      get levelIndex() { return levelIndex; },
      get isBusy() { return isBusy(); },
      get rescueLeft() { return rescueLeft; },
      get undoLeft() { return undoLeft; },
      get extraSlots() { return state ? extraSlotCount(state) : 0; },
      get hint() { return currentHint; },
      get bgmMuted() { return isBgmMuted(); },
      get bgmPlaying() { return isBgmPlaying(); },
      get bgmMode() { return getBgmMode(); },
      get tutorial() { return tutorial.debug(); },
      startLevel,
      showLevelSelect,
      hideLevelSelect,
      clickBus: onBusClick,
      requestAddSlot,
      addSlot: performAddSlot,
      showHint,
      refreshHint,
      riskFor: getMoveRisk,
      undo,
      referenceMoves: () => level?.solution?.moves?.slice() ?? [],
    };
  }

  return { init };
}
