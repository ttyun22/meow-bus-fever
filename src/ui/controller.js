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
  boardPassengers,
  departReady,
  settleAll,
  checkWin,
  checkLose,
  loseReason,
  GAME_CONFIG,
} from '../game/logic.js';
import {
  getLevelByIndex,
  getLevelCount,
  listLevelSummaries,
  validateLevelConfig,
} from '../game/levelRegistry.js';
import { createRenderer } from './render.js';
import { playSound, unlockAudio, isMuted, setMuted } from './sound.js';
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

  let pendingRelayout = false;
  let toastTimer = null;
  let areaFlashTimer = null;
  let overlayPrimaryFn = null;
  let overlaySecondaryFn = null;

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
        default:
          return null;
      }
    },
  });

  /* ================= 撤回系统 =================
     快照 = 某次操作「提交前」的完整 state（structuredClone 深拷贝）。
     并行操作下，快照的弹出顺序 = 操作提交顺序（= 点击顺序，因为
     校验+提交在同一个同步栈内完成）。注意快照可能取于上一辆巴士的
     自动结算尚未回放的瞬间（并行期），因此撤回后同步执行一次
     settleAll 重放必然的自动结算，保证恢复到的是稳定闭环状态。
     约束：动画与结算进行中（isBusy）禁止撤回；胜负覆盖层出现后
     （已稳定）允许从 HUD 或失败覆盖层撤回；撤回本身不压栈、
     不消耗操作次数；重开/换关时整体重置。 */
  let undoStack = [];
  let undoLeft = GAME_CONFIG.UNDO_LIMIT;

  function resetUndo() {
    undoStack = [];
    undoLeft = GAME_CONFIG.UNDO_LIMIT;
    updateUndoBtn();
  }

  /** 撤回按钮的文案与可用状态（唯一入口，避免状态不一致）。 */
  function updateUndoBtn() {
    const btn = $('btn-undo');
    if (!btn) return;
    btn.textContent = `撤回（${undoLeft}）`;
    btn.disabled = !state || undoLeft <= 0 || undoStack.length === 0 || isBusy();
  }

  function undo() {
    if (!state) return;
    // 并行动画/结算未稳定：禁止恢复到半完成状态（按钮已禁用，此处双保险）
    if (isBusy()) return;
    if (undoLeft <= 0) { playSound('illegal'); toast('撤回次数已用完，可以「重开」重置。'); return; }
    if (undoStack.length === 0) { playSound('illegal'); toast('没有可撤回的操作。'); return; }
    bumpEpoch(); // 防御：废止任何遗留管线（稳定态下理论为空）
    state = undoStack.pop();
    undoLeft -= 1;
    settleAll(state); // 并行期快照可能未结算：同步重放自动上车/发车，回到稳定态
    hideOverlay();
    renderer.renderAll(state, level);
    tutorial.refresh();
    // 恢复并重放后若直接达成胜/负，走正常结算（胜负音效优先，不再放撤回音）
    if (checkWin(state)) showWin();
    else if (checkLose(state)) showLose();
    else { playSound('undo'); toast('已撤回到上一步'); }
    updateUndoBtn();
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
    resetUndo(); // 进入新关卡：撤回历史与次数不沿用上一关
    $('screen-start').classList.add('hidden');
    $('screen-levels').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
    renderer.renderAll(state, level);
    tutorial.startFor(level.id);
  }

  /** 关卡配置缺失/不合法：给出明确错误，而不是空白页。 */
  function showLevelError(detail) {
    bumpEpoch();
    state = null;
    hideOverlay();
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
    renderer.renderLevelSelect(listLevelSummaries(), state ? levelIndex : -1);
    $('screen-start').classList.add('hidden');
    $('screen-game').classList.add('hidden');
    $('screen-levels').classList.remove('hidden');
  }

  function hideLevelSelect() {
    $('screen-levels').classList.add('hidden');
    if (levelsFrom === 'game' && state) $('screen-game').classList.remove('hidden');
    else $('screen-start').classList.remove('hidden');
  }

  /** 重新开始当前关卡（不刷新页面，重建全新 state）。 */
  function restartLevel() {
    bumpEpoch();
    state = initializeLevel(level);
    pendingRelayout = false;
    hideOverlay();
    resetUndo(); // 重开 = 重建干净的初始状态（含撤回）
    renderer.renderAll(state, level);
    tutorial.startFor(level.id); // 已掌握的教学不会重复弹出
    toast('本关已重置');
  }

  /** 进入下一关（最后一关之后回到第 1 关，形成完整循环）。 */
  function loadNextLevel() {
    if (levelIndex >= getLevelCount() - 1) startLevel(0);
    else startLevel(levelIndex + 1);
  }

  /* ================= 点击巴士（并行入口） =================
     校验与提交在同一个同步栈内完成（无 await），因此多次快速点击的
     提交顺序 = 点击顺序，接客位预留原子生效，不存在竞态。 */
  function onBusClick(busId) {
    if (!state) return;
    // 已胜利/失败：覆盖层已给出结论，轻提示即可（覆盖层背景不拦截，
    // 玩家仍可从 HUD 撤回或重开）
    if (state.status !== 'playing') {
      toast('本局已结束，请撤回、重开或进入下一关。', 1600);
      return;
    }
    const bus = state.buses[busId];
    // 同一辆巴士不可重复处理：驶出提交后 status 立即变为 loading，
    // 动画期间的重复点击在此被忽略（不再使用全局输入锁）
    if (!bus || bus.status !== 'board') return;

    // 先校验（只读）：路径阻挡与接客位容量
    const check = validateMove(state, busId);
    if (!check.ok) {
      handleIllegalMove(busId, check);
      return;
    }
    // 原子提交：操作前快照 -> moveBus 同步完成驶出与接客位预留
    undoStack.push(structuredClone(state)); // 含其后全部自动结算的撤销能力
    const res = moveBus(state, busId);
    if (!res.ok) {
      undoStack.pop(); // 理论不可达（已 validate），防御：不留无主快照
      return;
    }
    commitOp(busId, res.events);
  }

  /** 提交一次驶出：登记并行资源，启动该车的独立动画管线（不阻塞输入）。 */
  function commitOp(busId, events) {
    const st = state;
    const ep = epoch;
    activeOps += 1;
    updateUndoBtn(); // 稳定前禁用撤回
    renderer.clearPathPreview();
    renderer.renderHud(st, level);
    tutorial.notify('exit', { busId });

    // 「已分配接客位」的到位承诺：结算循环播放该车动画前会等待它
    let arriveResolve;
    pendingArrivals.set(busId, new Promise((r) => { arriveResolve = r; }));
    runOp(st, ep, busId, events, arriveResolve); // 不 await：与其他巴士并行
  }

  /** 单辆巴士的动画管线：驶出棋盘 -> 到位接客位 -> 请求共享结算。 */
  async function runOp(st, ep, busId, events, arriveResolve) {
    try {
      activeExits += 1;
      for (const ev of events) {
        if (ev.type !== 'exit') continue;
        await animateExit(ev);
        if (st !== state || ep !== epoch) return; // 状态已易主：静默退出
      }
      activeExits -= 1;
      // 棋盘全量校准只在没有任何驶出动画时进行（防止 innerHTML 打断并行动画），
      // 同时刷新其他巴士的「可驶出」箭头
      if (activeExits === 0) {
        renderer.renderBoard(st);
        tutorial.refresh();
      }
      // 到位：该车在接客位可见
      renderer.renderSlots(st, { pop: busId });
      tutorial.refresh();
      await sleep(300);
      if (st !== state || ep !== epoch) return;
      pendingArrivals.delete(busId);
      arriveResolve();
      requestSettle();
    } finally {
      if (ep === epoch) {
        activeOps -= 1;
        maybeFinish();
      }
    }
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
    updateUndoBtn();
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
      const boardEvs = boardPassengers(st);
      for (const ev of boardEvs) {
        await waitArrival(ev.busId);
        if (st !== state || ep !== epoch) return;
        playSound('board');
        await animateBoard(st, ev);
      }
      if (boardEvs.length > 0) renderer.renderQueue(st);

      const departEvs = departReady(st);
      for (const ev of departEvs) {
        await waitArrival(ev.busId);
        if (st !== state || ep !== epoch) return;
        await animateDepart(st, ev);
      }
      if (departEvs.length > 0) renderer.renderSlots(st);

      if (boardEvs.length === 0 && departEvs.length === 0) break;
    }
  }

  /* ================= 稳定点：胜负判定 =================
     只在「无任何在途动画且结算循环空闲」时执行；checkWin/checkLose
     同步翻转 status，天然保证只触发一次。 */
  function maybeFinish() {
    updateUndoBtn();
    const st = state;
    const ep = epoch;
    if (!st || st.status !== 'playing') return;
    if (activeOps > 0 || settleRunning) return;
    if (checkWin(st)) {
      sleep(320).then(() => {
        if (st === state && ep === epoch) showWin();
      });
      return;
    }
    if (checkLose(st)) {
      sleep(320).then(() => {
        if (st === state && ep === epoch) showLose();
      });
      return;
    }
    if (pendingRelayout) {
      pendingRelayout = false;
      renderer.renderAll(st, level);
      tutorial.refresh();
    }
  }

  /* ================= 结算动画 ================= */

  /** 巴士驶出停车场：沿朝向滑出棋盘。 */
  async function animateExit(ev) {
    const el = renderer.getBoardBus(ev.busId);
    if (!el) return;
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

  /** 队首乘客飞进接客位的巴士。 */
  async function animateBoard(st, ev) {
    const qEl = renderer.getQueueHead();
    const slotBusEl = renderer.getSlotBus(ev.busId);
    if (!qEl || !slotBusEl) {
      renderer.renderSlots(st);
      renderer.bumpSlotBus(ev.busId);
      await sleep(180);
      return;
    }
    const from = qEl.getBoundingClientRect();
    const to = slotBusEl.getBoundingClientRect();
    // 把乘客元素提升为 fixed，从原位置飞向目标（避免被容器裁剪）
    qEl.classList.remove('head');
    qEl.classList.add('flying');
    document.body.appendChild(qEl);
    qEl.style.left = `${from.left}px`;
    qEl.style.top = `${from.top}px`;
    void qEl.offsetWidth; // 强制 reflow，确保起点生效
    qEl.style.left = `${to.left + to.width / 2 - from.width / 2}px`;
    qEl.style.top = `${to.top + to.height / 2 - from.height / 2}px`;
    qEl.style.transform = 'scale(.45)';
    qEl.style.opacity = '0';
    await sleep(320);
    qEl.remove();
    // 更新接客位巴士的计数与座位点
    renderer.renderSlots(st);
    renderer.bumpSlotBus(ev.busId);
    await sleep(120);
  }

  /** 满载巴士从接客位发车离场。 */
  async function animateDepart(st, ev) {
    const el = renderer.getSlotBus(ev.busId);
    if (!el) {
      renderer.renderSlots(st);
      await sleep(200);
      return;
    }
    el.classList.add('anim-depart');
    el.style.transform = 'translateX(150%)';
    el.style.opacity = '0';
    await sleep(460);
    // 并行期间该接客位可能已分配给新巴士：renderSlots 按当前 state
    // 全量重建，与新车的到位渲染天然兼容
    renderer.renderSlots(st);
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

  function showWin() {
    playSound('win');
    tutorial.completeLevel(level.id); // 通关即「已掌握」本关教学，永不再弹
    updateUndoBtn(); // 覆盖层期允许 HUD 撤回（撤回可恢复继续游玩/优化步数）
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
    updateUndoBtn();
    // 死锁后最有价值的恢复路径：撤回导致死锁的那一步
    const canUndo = undoLeft > 0 && undoStack.length > 0;
    showOverlay({
      icon: '😵',
      title: '堵死了！',
      text: `${loseReason(state)}\n换个顺序再试试吧。`,
      primary: { label: '重试本关', fn: restartLevel },
      secondary: canUndo ? { label: '撤回一步', fn: undo } : null,
    });
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

  /* ================= 初始化 ================= */

  function init() {
    // 浏览器自动播放策略：首次用户手势时解锁 AudioContext
    window.addEventListener('pointerdown', unlockAudio);

    $('btn-start').addEventListener('click', () => { playSound('click'); startLevel(0); });
    $('btn-levels').addEventListener('click', () => { playSound('click'); showLevelSelect('start'); });
    $('btn-levels-back').addEventListener('click', () => { playSound('click'); hideLevelSelect(); });
    $('hud-level').addEventListener('click', () => { playSound('click'); showLevelSelect('game'); });
    $('level-grid').addEventListener('click', (e) => {
      const cell = e.target.closest('.level-cell');
      if (!cell) return;
      playSound('click');
      startLevel(Number(cell.dataset.levelIndex)); // 选关即跳转（含重玩当前关）
    });
    $('btn-restart').addEventListener('click', () => { playSound('click'); restartLevel(); });
    $('btn-undo').addEventListener('click', undo);
    $('btn-hint').addEventListener('click', () => {
      playSound('click');
      if (level) toast(level.hint, 4000);
    });
    $('btn-mute').addEventListener('click', () => {
      setMuted(!isMuted());
      updateMuteBtn();
      playSound('click'); // 静音后无声、解除静音立即有声，即所得反馈
    });
    $('btn-overlay-primary').addEventListener('click', () => { playSound('click'); overlayPrimaryFn?.(); });
    $('btn-overlay-secondary').addEventListener('click', () => { playSound('click'); overlaySecondaryFn?.(); });
    updateMuteBtn();

    renderer.boardEl.addEventListener('click', (e) => {
      const busEl = e.target.closest('.bus');
      if (busEl) onBusClick(busEl.dataset.busId);
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

    window.addEventListener('resize', () => {
      if (isBusy()) { pendingRelayout = true; return; }
      if (state) {
        renderer.renderAll(state, level);
        tutorial.refresh();
      }
    });

    // 自动化测试 / 调试句柄（startLevel 供验证关卡错误提示路径）
    window.__game = {
      get state() { return state; },
      get level() { return level; },
      isBusy,
      startLevel,
      showLevelSelect,
      hideLevelSelect,
    };
  }

  return { init };
}
