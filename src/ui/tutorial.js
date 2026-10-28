/**
 * 分阶段教学系统
 * ------------------------------------------------------------
 * 设计原则：
 *  - 只在第 1–5 关做新手教学，第 6 关起正常游玩，不再连续弹提示；
 *  - 每关只教一个重点：
 *      1 关 = 点车 → 驶入车位 → 同色猫咪上车
 *      2 关 = 满员立刻离场，接客位循环使用
 *      3 关 = 车位周转不开时使用「加位」
 *      4 关 = 顺序卡住时用「重开」重置本关
 *      5 关 = 一句话综合练习，不再讲解长规则
 *  - 步骤可以用 when(state) 只在“现在真的用得上”时出现；
 *  - 高亮真实按钮 / 车辆 / 区域，玩家完成实际操作（exit / board /
 *    depart / add-slot / restart）后立即推进，不阻塞其他合法操作；
 *  - 玩家暂时不做，也只是看到一条小气泡，不影响点车、重开、加位；
 *  - 已完成/已跳过步骤会记住，重开或换关不会重复弹出同一段教学。
 * ------------------------------------------------------------
 */

/** 教学完成记录 / 进行到第几步（分开存储，重开后可继续而非从头）。 */
const DONE_KEY = 'bus-fever-tutorial-v2';
const PROGRESS_KEY = 'bus-fever-tutorial-progress-v2';

/**
 * 教学配置：key = 关卡 id，value = 步骤数组（按顺序播放）。
 * 步骤字段：
 *  - text:      气泡文案（短，一句话说清“现在做什么、有什么用”）；
 *  - target:    高亮目标 { type: 'bus'|'queue'|'slots'|'board'|'rescue'|'restart', id? }；
 *  - when:      (state) => boolean，条件成立才出现（避免在无关局面打扰）；
 *  - requires:  'rescue' 等能力名，由控制器确认技能此刻是否可用；
 *  - triggerOn: { event, busId? }，等到某个事件发生后再显示；
 *  - doneOn:    完成事件 { event: 'exit'|'blocked'|'board'|'depart'|'add-slot'|'restart', busId? }；
 *  - skipOn:    跳过事件（玩家直接做了后续动作，说明已掌握）；
 *  - done:      状态谓词 (state) => boolean，步骤开始时已满足则直接跳过；
 *  - passive:   被动提示自动结束毫秒数（无操作要求）。
 */
export const TUTORIALS = {
  // 第 1 关：基础循环——点车、进车位、同色上车
  1: [
    {
      id: 'l1-exit',
      text: '点一下红色巴士，让它沿车顶箭头方向驶出停车场',
      target: { type: 'bus', id: 'b1' },
      doneOn: { event: 'exit', busId: 'b1' },
      done: (s) => s.buses.b1?.status !== 'board',
    },
    {
      id: 'l1-board',
      text: '红猫会自动上车——只上同色巴士，进度看接客位顶部的 1/2',
      target: { type: 'slots' },
      when: (s) => Object.values(s.buses).some((b) => b.status === 'moving' || b.status === 'loading'),
      doneOn: { event: 'board' },
    },
  ],
  // 第 2 关：上满即走，接客位循环使用
  2: [
    {
      id: 'l2-clear',
      text: '绿色巴士没被挡住，先点它清出通道',
      target: { type: 'bus', id: 'g1' },
      doneOn: { event: 'exit', busId: 'g1' },
      done: (s) => s.buses.g1?.status !== 'board',
    },
    {
      id: 'l2-full',
      text: '绿猫坐满 2/2，巴士会立刻离场，把接客位腾给下一辆',
      target: { type: 'slots' },
      // 从巴士驶入接客位开始提示，直到它满员离场；窗口足够长，
      // 不会因为两只猫上车的动画太快而错过。
      when: (s) => {
        const bus = s.buses.g1;
        return !!bus
          && (bus.status === 'moving' || bus.status === 'loading')
          && bus.passengers < bus.capacity;
      },
      doneOn: { event: 'depart' },
    },
  ],
  // 第 3 关：在车位开始周转时认识「加位」
  3: [
    {
      id: 'l3-head',
      text: '先看队首颜色：现在放红色巴士最省接客位',
      target: { type: 'bus', id: 'r1' },
      doneOn: { event: 'exit', busId: 'r1' },
      done: (s) => s.buses.r1?.status !== 'board',
    },
    {
      id: 'l3-add',
      text: '车位周转不开时，点「加位」可临时多 1 个接客位；想试试就点它',
      target: { type: 'rescue' },
      requires: 'rescue',
      // 第一次成功驶出后，等动画/结算结束（requires 会检查按钮可用）
      // 就提示；即使车位刚好腾空，玩家也能理解这个应急工具。
      when: (s) => s.status === 'playing'
        && s.queue.length > 0
        && s.moveCount >= 1,
      doneOn: { event: 'add-slot' },
      passive: 10000,
    },
  ],
  // 第 4 关：遇到卡住的局面，知道可以重开本关
  4: [
    {
      id: 'l4-start',
      text: '队首是蓝色，先点没被挡住蓝色长车',
      target: { type: 'bus', id: 'b1' },
      doneOn: { event: 'exit', busId: 'b1' },
      done: (s) => s.buses.b1?.status !== 'board',
    },
    {
      id: 'l4-restart',
      text: '顺序乱了或卡住时，点「重开」就能重置本关，不用刷新页面',
      target: { type: 'restart' },
      when: (s) => s.status === 'lost'
        || s.moveCount >= 3
        || s.slots.every((slot) => slot.busId != null),
      passive: 12000,
      doneOn: { event: 'restart' },
    },
  ],
  // 第 5 关：一句话综合练习，不再重复大段规则
  5: [
    {
      id: 'l5-practice',
      text: '先看队首颜色，再按阻挡顺序放车；卡住时用「加位」或「重开」',
      target: { type: 'queue' },
      when: (s) => s.moveCount >= 1,
      passive: 4200,
    },
  ],
};

/**
 * 创建教学控制器。
 * @param {object} deps
 *   - getState(): 当前游戏 state（只读）
 *   - resolveTarget(target): 按 target 描述返回高亮 DOM 元素（可为 null）
 *   - isActionAvailable(name): 技能此刻是否可用（例如加位次数 / 动画状态）
 */
export function createTutorial({ getState, resolveTarget, isActionAvailable }) {
  const bubble = document.getElementById('tut-bubble');
  const textEl = document.getElementById('tut-text');
  const okBtn = document.getElementById('tut-ok');
  const closeBtn = document.getElementById('tut-close');

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch {
      return fallback; // 隐私模式等场景按“无记录”处理
    }
  };

  /** 已完整学完的关卡（持久化，掌握后不再弹）。 */
  const storedDone = readJSON(DONE_KEY, []);
  let doneSet = new Set(Array.isArray(storedDone) ? storedDone : []);
  /** 每关下一段要看的步骤序号（重开/刷新后继续，不重复已看过的步骤）。 */
  const storedProgress = readJSON(PROGRESS_KEY, {});
  let progress = new Map(
    storedProgress && typeof storedProgress === 'object' && !Array.isArray(storedProgress)
      ? Object.entries(storedProgress)
      : []
  );

  let active = null;   // { levelId, idx, timer, poll, shown, triggered }
  let ringEl = null;   // 当前高亮元素
  let poll = null;

  function persist() {
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify([...doneSet]));
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(progress)));
    } catch { /* 忽略存储失败 */ }
  }

  function stepsFor(levelId) {
    return TUTORIALS[levelId] || null;
  }

  function currentStep() {
    if (!active) return null;
    return stepsFor(active.levelId)?.[active.idx] ?? null;
  }

  function clearRing() {
    if (ringEl) {
      ringEl.classList.remove('tut-ring');
      ringEl = null;
    }
  }

  function hideBubble() {
    bubble.classList.add('hidden');
    bubble.dataset.arrow = 'none';
  }

  /** 定位气泡到目标附近（上方优先，空间不足放下方；水平夹取在视口内）。 */
  function placeBubble(el) {
    bubble.classList.remove('hidden');
    const vw = document.documentElement.clientWidth;
    const vh = window.visualViewport?.height || document.documentElement.clientHeight;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let left;
    let top;
    let arrow = 'none';
    let arrowX = bw / 2;
    if (el) {
      const r = el.getBoundingClientRect();
      left = r.left + r.width / 2 - bw / 2;
      top = r.top - bh - 10;
      if (top < 8) { // 上方没空间 -> 放下面，箭头朝上
        top = r.bottom + 10;
        arrow = 'up';
      } else {
        arrow = 'down';
      }
      arrowX = Math.max(18, Math.min(bw - 18, r.left + r.width / 2 - left));
    } else {
      left = vw / 2 - bw / 2;
      top = vh * 0.2;
    }
    left = Math.max(8, Math.min(left, vw - bw - 8));
    top = Math.max(8, Math.min(top, vh - bh - 8));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.dataset.arrow = arrow;
    bubble.style.setProperty('--arrow-x', `${arrowX}px`);
  }

  /** 当前步骤是否已经可以显示（when / requires / triggerOn 都满足）。 */
  function canShow(step) {
    if (!step) return false;
    const state = getState();
    if (!state) return false;
    if (active.triggerOnStep && !active.triggered) return false;
    if (step.when && !step.when(state)) return false;
    if (step.requires && !(isActionAvailable?.(step.requires) ?? true)) return false;
    return true;
  }

  function showStep(step) {
    active.shown = true;
    clearTimeout(active.timer);
    active.timer = null;

    textEl.textContent = step.text;
    okBtn.classList.toggle('hidden', !step.passive);
    okBtn.textContent = '知道了';

    clearRing();
    const el = resolveTarget(step.target);
    if (el) {
      el.classList.add('tut-ring');
      ringEl = el;
    }
    placeBubble(el);

    if (step.passive) {
      active.timer = setTimeout(advance, step.passive);
    }
  }

  /** 等待中的步骤：条件满足才显示；不满足时保持安静。 */
  function evaluate() {
    if (!active) return;
    const step = currentStep();
    if (!step) {
      finishLevel();
      return;
    }
    if (step.done && step.done(getState())) {
      advance();
      return;
    }
    if (active.shown) return;
    if (!canShow(step)) {
      hideBubble();
      clearRing();
      return;
    }
    showStep(step);
  }

  function startPoll() {
    clearInterval(poll);
    poll = setInterval(evaluate, 300);
  }

  function stopPoll() {
    clearInterval(poll);
    poll = null;
  }

  function advance() {
    if (!active) return;
    const levelId = active.levelId;
    active.idx += 1;
    active.shown = false;
    active.triggered = false;
    active.triggerOnStep = null;
    clearTimeout(active.timer);
    active.timer = null;

    const steps = stepsFor(levelId);
    if (!steps || active.idx >= steps.length) {
      progress.delete(String(levelId));
      finishLevel();
      return;
    }
    progress.set(String(levelId), active.idx);
    persist();
    // 进入下一步前先恢复“最多一个高亮”的状态。
    clearRing();
    hideBubble();
    active.triggerOnStep = steps[active.idx].triggerOn || null;
    active.triggered = false;
    evaluate();
  }

  function finishLevel() {
    if (!active) return;
    doneSet.add(String(active.levelId));
    progress.delete(String(active.levelId));
    persist();
    stop();
  }

  function stop() {
    if (active?.timer) clearTimeout(active.timer);
    active = null;
    stopPoll();
    clearRing();
    hideBubble();
  }

  /* ---------------- 对外接口 ---------------- */

  /** 进入关卡时调用：已掌握的关卡直接跳过；重开则从上次进度继续。 */
  function startFor(levelId) {
    stop();
    if (doneSet.has(String(levelId))) return;
    const steps = stepsFor(levelId);
    if (!steps || steps.length === 0) return;

    let idx = Number(progress.get(String(levelId)) ?? 0);
    if (!Number.isInteger(idx) || idx < 0) idx = 0;
    const state = getState();
    // 如果玩家在提示出现前已经完成了某些动作，直接跳过对应步骤。
    while (idx < steps.length && state && steps[idx].done?.(state)) idx += 1;
    if (idx >= steps.length) {
      doneSet.add(String(levelId));
      progress.delete(String(levelId));
      persist();
      return;
    }

    const step = steps[idx];
    active = {
      levelId,
      idx,
      timer: null,
      shown: false,
      triggered: false,
      triggerOnStep: step.triggerOn || null,
      poll: null,
    };
    startPoll();
    evaluate();
  }

  /**
   * 游戏事件通知：'exit'（巴士已驶出）/ 'blocked'（点击被挡）/
   * 'board'（猫咪上车）/ 'depart'（满员发车）/ 'add-slot' / 'restart'。
   * 命中当前步骤的 doneOn/skipOn 即推进；否则重新评估 when。
   */
  function notify(event, payload = {}) {
    if (!active) return;
    const step = currentStep();
    if (!step) return;
    const hit = (cond) => cond
      && cond.event === event
      && (!cond.busId || cond.busId === payload.busId);

    if (hit(step.triggerOn)) active.triggered = true;
    if (hit(step.doneOn) || hit(step.skipOn)) {
      advance();
      return;
    }
    evaluate();
  }

  /** 渲染层重建 DOM 后调用：重新挂载高亮并重新定位气泡。 */
  function refresh() {
    if (!active) return;
    if (!active.shown) {
      evaluate();
      return;
    }
    const step = currentStep();
    if (!step) return;
    clearRing();
    const el = resolveTarget(step.target);
    if (el) {
      el.classList.add('tut-ring');
      ringEl = el;
    }
    placeBubble(el);
  }

  /** 通关即掌握：把指定关卡的教学标记为已完成并收起气泡。 */
  function completeLevel(levelId) {
    doneSet.add(String(levelId));
    progress.delete(String(levelId));
    persist();
    if (active && String(active.levelId) === String(levelId)) stop();
  }

  okBtn.addEventListener('click', () => {
    // 仅被动步骤显示该按钮：点击 = 读完，提前结束本步。
    advance();
  });

  closeBtn?.addEventListener('click', () => {
    // 主动关闭当前提示 = 已读/暂不需要，不再反复弹出。
    advance();
  });

  function debug() {
    if (!active) return null;
    const step = currentStep();
    return {
      levelId: active.levelId,
      idx: active.idx,
      id: step?.id ?? null,
      shown: !!active.shown,
      waiting: !active.shown,
    };
  }

  return { startFor, notify, refresh, stop, completeLevel, debug };
}