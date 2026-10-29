/**
 * 《猫咪巴士大疏通》关卡配置（唯一数据源）
 * ------------------------------------------------------------
 * 每一关都是纯数据：固定、可重复、无运行时随机。
 *
 * 如何新增关卡：
 *  1. 在下方 LEVELS 数组追加一份配置对象（字段格式见
 *     levelRegistry.js 顶部注释；校验规则也在那里）；
 *  2. 运行 `node src/game/solver.js`：自动完成配置校验、
 *     可解性验证（小关卡 BFS / 高密度参考解回放）与解法比对；
 *  3. 第 10–50 关由 tools/generate-levels.mjs 生成到
 *     generatedLevels.js，再在这里展开。
 *
 * 字段说明：
 *  - id / name：编号与名称
 *  - difficulty：难度标签 1..5（元数据）
 *  - intent：  设计意图（给策划/开发者看）
 *  - hint：    玩家可查看的提示
 *  - grid：    停车场网格 { cols, rows }
 *  - slots：   接客位数量
 *  - buses：   巴士 [{ id, color, len, dir, x, y, capacity }]
 *              dir 为车头朝向（也是唯一可移动方向）；
 *              锚点 (x,y)：水平车是最左格，竖直车是最上格。
 *              capacity 为每辆车独立的载客容量，必须是 2/4/6，且与 len 严格对应：
 *              2 座=2 格、4 座=3 格、6 座=4 格。
 *  - queue：   候车乘客颜色序列，index 0 是队首（最先进队、最先上车）。
 *  - solution：参考解法（点击驶出的巴士 id 顺序；由 solver.js 用
 *              与游戏一致的规则验证过。第 1–9 关 par 为 BFS 最短步数；
 *              第 10–50 关 par 为参考解步数，不声明最短）。
 *
 * 坐标系：x 向右，y 向下，(0,0) 在左上角。
 * ------------------------------------------------------------
 */

import { GENERATED_LEVELS } from './generatedLevels.js';

export const LEVELS = [
  {
    id: 1,
    difficulty: 1,
    name: '初来乍到',
    intent:
      '教学关：两条互不阻挡的横向巴士，队列顺序与巴士颜色一一对应。' +
      '玩家点击 -> 驶出 -> 自动上车 -> 满载发车，一次走完整个核心循环，' +
      '理解「点击驶出 / 颜色匹配 / 满载发车」三个规则。无任何失败风险。',
    hint: '点击红色巴士！它会驶出停车场，自动接走队首的红色乘客。',
    grid: { cols: 5, rows: 3 },
    slots: 4,
    buses: [
      { id: 'b1', color: 'red', len: 2, dir: 'right', x: 0, y: 1, capacity: 2 },
      { id: 'b2', color: 'blue', len: 2, dir: 'right', x: 2, y: 2, capacity: 2 },
    ],
    queue: ['red', 'red', 'blue', 'blue'],
    solution: { moves: ['b1', 'b2'], par: 2 },
  },

  {
    id: 2,
    difficulty: 2,
    name: '谁挡了谁',
    intent:
      '引入「阻挡关系」：红巴士被绿巴士挡住（绿在红的前方），' +
      '必须先移走绿才能放红出来。队列队首正好是畅通的绿色，' +
      '玩家先走绿色能立刻得到正反馈，再自然理解「挡路的先走、被挡的后走」。' +
      '4 个接客位让容错更宽松，但把不对色的车都停进来仍会拖慢节奏。',
    hint: '队首是绿色。绿色巴士正好畅通，先送走绿猫；它离开后红色才能出来。',
    grid: { cols: 5, rows: 3 },
    slots: 4,
    buses: [
      { id: 'r1', color: 'red', len: 2, dir: 'right', x: 0, y: 0, capacity: 2 },
      { id: 'g1', color: 'green', len: 2, dir: 'right', x: 2, y: 0, capacity: 2 },
      { id: 'b1', color: 'blue', len: 2, dir: 'right', x: 0, y: 2, capacity: 2 },
    ],
    queue: ['green', 'green', 'red', 'red', 'blue', 'blue'],
    solution: { moves: ['g1', 'r1', 'b1'], par: 3 },
  },

  {
    id: 3,
    difficulty: 2,
    name: '队首优先',
    intent:
      '引入「队列顺序」的软约束：4 个接客位提高了容错，' +
      '队首是红色，而红巴士畅通，绿被红挡、蓝畅通但接不了客。' +
      '按队首颜色放车最顺畅；乱停虽然不会立刻失败，但会占住周转空间。',
    hint: '看队首颜色放车最省接客位：先红、再绿、最后蓝。',
    grid: { cols: 5, rows: 4 },
    slots: 4,
    buses: [
      { id: 'g1', color: 'green', len: 2, dir: 'right', x: 0, y: 1, capacity: 2 },
      { id: 'r1', color: 'red', len: 2, dir: 'right', x: 3, y: 1, capacity: 2 },
      { id: 'b1', color: 'blue', len: 2, dir: 'right', x: 0, y: 3, capacity: 2 },
    ],
    queue: ['red', 'red', 'green', 'green', 'blue', 'blue'],
    solution: { moves: ['r1', 'g1', 'b1'], par: 3 },
  },

  {
    id: 4,
    difficulty: 3,
    name: '层层开路',
    intent:
      '引入「不同长度 + 竖直朝向」与三层依赖链：' +
      '蓝(长3,横) 占 (2,4) 挡竖直绿(长3)；绿占 (2,2) 挡红(横)。' +
      '队列顺序正好是 蓝 -> 绿 -> 红：开局蓝巴士畅通，先给正反馈；' +
      '绿、红逐层解锁，紫畅通但排在最后。4 个接客位允许一定试错，' +
      '但把 4 辆不对色的车都停住，仍会失去周转空间。',
    hint: '队首是蓝色。先移走底部的蓝色长巴士，再按绿→红逐层开路；紫色最后。',
    grid: { cols: 6, rows: 5 },
    slots: 4,
    buses: [
      { id: 'p1', color: 'purple', len: 2, dir: 'right', x: 4, y: 0, capacity: 2 },
      { id: 'g1', color: 'green', len: 3, dir: 'down', x: 2, y: 1, capacity: 4 },
      { id: 'r1', color: 'red', len: 2, dir: 'right', x: 0, y: 2, capacity: 2 },
      { id: 'b1', color: 'blue', len: 3, dir: 'right', x: 0, y: 4, capacity: 4 },
    ],
    queue: [
      'blue', 'blue', 'blue', 'blue',
      'green', 'green', 'green', 'green',
      'red', 'red',
      'purple', 'purple',
    ],
    solution: { moves: ['b1', 'g1', 'r1', 'p1'], par: 4 },
  },

  {
    id: 5,
    difficulty: 4,
    name: '终极疏通',
    intent:
      '综合关：组合路径依赖链、双向竖直（青朝上）、多种长度、颜色错位与 4 个接客位。' +
      '依赖链：绿(畅通) & 青(畅通) 先出；青出 -> 蓝畅通；绿+蓝出 -> 红畅通；红出 -> 橙畅通。' +
      '队列顺序 绿->青->紫->蓝->红->橙 与出场难度错位（蓝/红/橙在深处），' +
      '需要逐层疏通并控制放车时机。4 个接客位是缓冲，不是无限仓库。',
    hint: '通往出口的路层层叠叠：绿、青先走，然后蓝、红、橙逐层疏通。紫色不着急。',
    grid: { cols: 7, rows: 6 },
    slots: 4,
    buses: [
      { id: 'o1', color: 'orange', len: 2, dir: 'right', x: 0, y: 0, capacity: 2 },
      { id: 'r1', color: 'red', len: 2, dir: 'down', x: 2, y: 0, capacity: 2 },
      { id: 'p1', color: 'purple', len: 2, dir: 'right', x: 4, y: 1, capacity: 2 },
      { id: 'c1', color: 'cyan', len: 3, dir: 'up', x: 6, y: 2, capacity: 4 },
      { id: 'b1', color: 'blue', len: 2, dir: 'right', x: 2, y: 3, capacity: 2 },
      { id: 'g1', color: 'green', len: 4, dir: 'right', x: 0, y: 5, capacity: 6 },
    ],
    queue: [
      'green', 'green', 'green', 'green', 'green', 'green',
      'cyan', 'cyan', 'cyan', 'cyan',
      'purple', 'purple',
      'blue', 'blue',
      'red', 'red',
      'orange', 'orange',
    ],
    solution: { moves: ['g1', 'c1', 'p1', 'b1', 'r1', 'o1'], par: 6 },
  },

  /* ================= 第 6-9 关：机制教学收尾 =================
     第 1-5 关保留原始教学设计；第 6-9 关逐步加入多方向、长短车、
     纵向阻挡与「提前停车等待」。
     第 10-50 关由 generatedLevels.js 提供：31-60 辆车的高密度车阵，
     每关都有确定性的参考解法与 12×12 自动缩放布局。 */

  {
    id: 6,
    difficulty: 1,
    name: '方向初探',
    intent:
      '5 辆车 · 5×5 场地 · 4 个接客位 · 3 层阻挡链。最短解 5 步，按阻挡链与队列颜色顺序放行即可，不需要提前等待。前期教学：车辆少、链短，先熟悉多方向驶出与队列颜色顺序。',
    hint: '队首是蓝色。先找车头朝外、路径畅通的车；没有阻挡时按队首颜色依次放行。',
    grid: { cols: 5, rows: 5 },
    slots: 4,
    buses: [
      { id: 'b1', color: 'purple', len: 2, dir: 'down', x: 1, y: 1, capacity: 2 },
      { id: 'b2', color: 'blue', len: 2, dir: 'down', x: 3, y: 2, capacity: 2 },
      { id: 'b3', color: 'cyan', len: 2, dir: 'up', x: 2, y: 2, capacity: 2 },
      { id: 'b4', color: 'yellow', len: 2, dir: 'left', x: 2, y: 1, capacity: 2 },
      { id: 'b5', color: 'green', len: 2, dir: 'left', x: 1, y: 4, capacity: 2 },
    ],
    queue: [
      'blue', 'blue',
      'green', 'green',
      'purple', 'purple',
      'yellow', 'yellow',
      'cyan', 'cyan',
    ],
    solution: { moves: ['b2', 'b5', 'b1', 'b4', 'b3'], par: 5 },
  },

  {
    id: 7,
    difficulty: 1,
    name: '上下分流',
    intent:
      '5 辆车 · 5×5 场地 · 4 个接客位 · 2 层阻挡链。最短解 5 步，按阻挡链与队列颜色顺序放行即可，不需要提前等待。前期教学：车辆少、链短，先熟悉多方向驶出与队列颜色顺序。',
    hint: '队首是红色。先找车头朝外、路径畅通的车；没有阻挡时按队首颜色依次放行。',
    grid: { cols: 5, rows: 5 },
    slots: 4,
    buses: [
      { id: 'b1', color: 'green', len: 2, dir: 'down', x: 1, y: 3, capacity: 2 },
      { id: 'b2', color: 'red', len: 2, dir: 'up', x: 1, y: 0, capacity: 2 },
      { id: 'b3', color: 'blue', len: 2, dir: 'left', x: 3, y: 1, capacity: 2 },
      { id: 'b4', color: 'purple', len: 2, dir: 'up', x: 4, y: 2, capacity: 2 },
      { id: 'b5', color: 'yellow', len: 2, dir: 'left', x: 2, y: 0, capacity: 2 },
    ],
    queue: [
      'red', 'red',
      'green', 'green',
      'blue', 'blue',
      'yellow', 'yellow',
      'purple', 'purple',
    ],
    solution: { moves: ['b2', 'b1', 'b3', 'b5', 'b4'], par: 5 },
  },

  {
    id: 8,
    difficulty: 1,
    name: '双排链',
    intent:
      '6 辆车 · 6×5 场地 · 4 个接客位 · 4 层阻挡链。最短解 6 步，按阻挡链与队列颜色顺序放行即可，不需要提前等待。前期教学：车辆少、链短，先熟悉多方向驶出与队列颜色顺序。',
    hint: '队首是黄色。先找车头朝外、路径畅通的车；没有阻挡时按队首颜色依次放行。',
    grid: { cols: 6, rows: 5 },
    slots: 4,
    buses: [
      { id: 'b1', color: 'purple', len: 2, dir: 'up', x: 2, y: 3, capacity: 2 },
      { id: 'b2', color: 'blue', len: 2, dir: 'down', x: 0, y: 0, capacity: 2 },
      { id: 'b3', color: 'green', len: 2, dir: 'right', x: 1, y: 0, capacity: 2 },
      { id: 'b4', color: 'yellow', len: 2, dir: 'right', x: 2, y: 2, capacity: 2 },
      { id: 'b5', color: 'red', len: 2, dir: 'right', x: 0, y: 4, capacity: 2 },
      { id: 'b6', color: 'cyan', len: 2, dir: 'left', x: 4, y: 1, capacity: 2 },
    ],
    queue: [
      'yellow', 'yellow',
      'green', 'green',
      'purple', 'purple',
      'red', 'red',
      'blue', 'blue',
      'cyan', 'cyan',
    ],
    solution: { moves: ['b4', 'b3', 'b1', 'b5', 'b2', 'b6'], par: 6 },
  },

  {
    id: 9,
    difficulty: 2,
    name: '竖列放行',
    intent:
      '6 辆车 · 6×5 场地 · 4 个接客位 · 3 层阻挡链。最短解 6 步，其中至少 1 次要把非队首色的车提前停入接客位；接客位是周转资源，别把 4 个位置全停满。前期教学：车辆少、链短，先熟悉多方向驶出与队列颜色顺序。',
    hint: '队首是蓝色。开局可参考：蓝、红、紫。有 4 个接客位，也要给队首颜色留出周转空间。',
    grid: { cols: 6, rows: 5 },
    slots: 4,
    buses: [
      { id: 'b1', color: 'yellow', len: 2, dir: 'right', x: 2, y: 4, capacity: 2 },
      { id: 'b2', color: 'red', len: 2, dir: 'left', x: 4, y: 0, capacity: 2 },
      { id: 'b3', color: 'purple', len: 2, dir: 'up', x: 0, y: 2, capacity: 2 },
      { id: 'b4', color: 'green', len: 2, dir: 'down', x: 3, y: 1, capacity: 2 },
      { id: 'b5', color: 'orange', len: 2, dir: 'left', x: 3, y: 3, capacity: 2 },
      { id: 'b6', color: 'blue', len: 2, dir: 'left', x: 0, y: 1, capacity: 2 },
    ],
    queue: [
      'blue', 'blue',
      'red', 'red',
      'purple', 'purple',
      'orange', 'orange',
      'green', 'green',
      'yellow', 'yellow',
    ],
    solution: { moves: ['b6', 'b2', 'b3', 'b5', 'b1', 'b4'], par: 6 },
  },
  ...GENERATED_LEVELS,
];
