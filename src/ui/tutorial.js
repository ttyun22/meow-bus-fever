/**
 * 分阶段教学系统
 * ------------------------------------------------------------
 * 设计原则：
 *  - 教学配置（TUTORIALS）与关卡数据（levels.js）完全分离：
 *    关卡只描述棋盘/队列，教学只描述「这一关第一次教什么」；
 *  - 每关聚焦一个主要机制，步骤短、带局部高亮与气泡文案；
 *  - 引导步骤在玩家完成指定操作（exit / blocked 事件）后自动推进；
 *    被动步骤（pure tips）到时自动消失，也可点「知道了」跳过；
 *  - 教学全程不阻塞任何合法操作：高亮只是提示，点击其他巴士照常工作；
 *  - 已完成教学持久化到 localStorage：失败/重开/换设备后不再重复弹出；
 *  - 若玩家在引导出现前已完成目标操作（state 谓词 done），步骤自动跳过。
 * ------------------------------------------------------------
 */

/** 教学完成记录的存储 key（值：已完成关卡 id 数组）。 */
const STORAGE_KEY = 'bus-fever-tutorial-v1';

/**
 * 教学配置：key = 关卡 id，value = 步骤数组（按顺序播放）。
 * 步骤字段：
 *  - text:     气泡文案（短）；
 *  - target:   高亮目标 { type: 'bus'|'queue'|'slots'|'board', id? }；
 *  - doneOn:   引导步骤的完成事件 { event: 'exit'|'blocked', busId }；
 *  - skipOn:   跳过事件（玩家直接做了后续动作，说明已掌握）；
 *  - done:     状态谓词 (state) => boolean，步骤开始时已满足则直接跳过；
 *  - passive:  被动提示的自动结束毫秒数（无操作要求）。
 */
export const TUTORIALS = {
  // 第 1 关：基本上车与颜色匹配
  1: [
    {
      id: 'l1-exit',
      text: '点一下红色巴士，让它沿车头方向驶出停车场',
      target: { type: 'bus', id: 'b1' },
      doneOn: { event: 'exit', busId: 'b1' },
      done: (s) => s.buses.b1?.status !== 'board',
    },
    {
      id: 'l1-match',
      text: '队首的红色乘客会自动登上红色巴士——只有同色的乘客才上车',
      target: { type: 'queue' },
      passive: 4200,
    },
  ],
  // 第 2 关：驶出路径阻挡
  2: [
    {
      id: 'l2-blocked',
      text: '红色巴士好像出不去？点它一下试试',
      target: { type: 'bus', id: 'r1' },
      doneOn: { event: 'blocked', busId: 'r1' },
      skipOn: { event: 'exit', busId: 'g1' },
      done: (s) => s.buses.g1?.status !== 'board',
    },
    {
      id: 'l2-blocker',
      text: '是绿色巴士挡在前面！先点绿色巴士，把路让出来',
      target: { type: 'bus', id: 'g1' },
      doneOn: { event: 'exit', busId: 'g1' },
      done: (s) => s.buses.g1?.status !== 'board',
    },
  ],
  // 第 3 关：接客位容量与满载发车
  3: [
    {
      id: 'l3-slot',
      text: '本关只有 1 个接客位：巴士坐满（或接完同色乘客）才会发车腾出位置',
      target: { type: 'slots' },
      passive: 3400,
    },
    {
      id: 'l3-head',
      text: '接客位太金贵了——先看队首：是红色乘客，所以要先放红巴士',
      target: { type: 'bus', id: 'r1' },
      doneOn: { event: 'exit', busId: 'r1' },
      done: (s) => s.buses.r1?.status !== 'board',
    },
  ],
  // 第 4 关：顺序与死锁风险（简短提示）
  4: [
    {
      id: 'l4-order',
      text: '层层相依：蓝挡绿、绿挡红。按 蓝→绿→红 的顺序开路，紫色留到最后——接客位被无关巴士占满就会堵死',
      target: { type: 'board' },
      passive: 5000,
    },
  ],
  // 第 5 关：综合顺序提示（简短提示）
  5: [
    {
      id: 'l5-order',
      text: '顺序是王道：绿、青先走，再逐层放出蓝、红、橙。紫色不着急——接客位占满就输了',
      target: { type: 'board' },
      passive: 5000,
    },
  ],
};

/**
 * 创建教学控制器。
 * @param {object} deps
 *   - getState(): 当前游戏 state（只读）
 *   - resolveTarget(target): 按 target 描述返回高亮 DOM 元素（可为 null）
 */
export function createTutorial({ getState, resolveTarget }) {
  const bubble = document.getElementById('tut-bubble');
  const textEl = document.getElementById('tut-text');
  const okBtn = document.getElementById('tut-ok');

  /** 已完成教学的关卡 id 集合（持久化，掌握后永不再弹）。 */
  let doneSet = new Set();
  try {
    doneSet = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch { /* 隐私模式等场景下按「无记录」处理 */ }

  let active = null;     // { levelId, idx, timer }
  let ringEl = null;     // 当前高亮元素

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...doneSet]));
    } catch { /* 忽略存储失败 */ }
  }

  function clearRing() {
    if (ringEl) {
      ringEl.classList.remove('tut-ring');
      ringEl = null;
    }
  }

  function hideBubble() {
    bubble.classList.add('hidden');
  }

  /** 定位气泡到目标附近（上方优先，空间不足放下方；水平夹取在视口内）。 */
  function placeBubble(el) {
    bubble.classList.remove('hidden');
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // 先显示再测量自身尺寸
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let left;
    let top;
    if (el) {
      const r = el.getBoundingClientRect();
      left = r.left + r.width / 2 - bw / 2;
      top = r.top - bh - 10;
      if (top < 8) top = r.bottom + 10; // 上方没空间 -> 放下面
    } else {
      left = vw / 2 - bw / 2;
      top = vh * 0.22;
    }
    left = Math.max(8, Math.min(left, vw - bw - 8));
    top = Math.max(8, Math.min(top, vh - bh - 8));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }

  function applyStep() {
    if (!active) return;
    const steps = TUTORIALS[active.levelId];
    const step = steps[active.idx];
    // 状态谓词：目标操作在教程出现前已完成 -> 直接跳过本步
    if (step.done && step.done(getState())) {
      advance();
      return;
    }
    clearRing();
    clearTimeout(active.timer);
    active.timer = null;

    textEl.textContent = step.text;
    okBtn.classList.toggle('hidden', !step.passive);

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

  function advance() {
    if (!active) return;
    active.idx += 1;
    const steps = TUTORIALS[active.levelId];
    if (active.idx >= steps.length) {
      // 全部步骤完成：持久化，永不再弹
      doneSet.add(String(active.levelId));
      persist();
      stop();
      return;
    }
    applyStep();
  }

  function stop() {
    if (active?.timer) clearTimeout(active.timer);
    active = null;
    clearRing();
    hideBubble();
  }

  /* ---------------- 对外接口 ---------------- */

  /** 进入关卡时调用：已掌握的关卡直接跳过。 */
  function startFor(levelId) {
    stop();
    if (doneSet.has(String(levelId))) return;
    const steps = TUTORIALS[levelId];
    if (!steps || steps.length === 0) return;
    active = { levelId, idx: 0, timer: null };
    applyStep();
  }

  /**
   * 游戏事件通知：'exit'（巴士已驶出）/ 'blocked'（点击被挡）。
   * 命中当前步骤的 doneOn/skipOn 即推进。
   */
  function notify(event, payload = {}) {
    if (!active) return;
    const step = TUTORIALS[active.levelId][active.idx];
    const hit = (cond) =>
      cond && cond.event === event && (!cond.busId || cond.busId === payload.busId);
    if (hit(step.doneOn) || hit(step.skipOn)) advance();
  }

  /** 渲染层重建 DOM 后调用：重新挂载高亮并重新定位气泡。 */
  function refresh() {
    if (!active) return;
    const step = TUTORIALS[active.levelId][active.idx];
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
    persist();
    if (active && String(active.levelId) === String(levelId)) stop();
  }

  okBtn.addEventListener('click', () => {
    // 仅被动步骤显示该按钮：点击 = 读完，提前结束本步
    advance();
  });

  return { startFor, notify, refresh, stop, completeLevel };
}
