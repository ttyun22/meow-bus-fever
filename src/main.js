/**
 * 《巴士大疏通》入口
 * 组装：核心逻辑(src/game) 与 渲染/控制(src/ui) 完全分离，
 * 本文件只负责启动控制器与开始页示例素材注入。
 */
import { createController } from './ui/controller.js';
import { busSvgMarkup } from './ui/render.js';
import { getLevelCount } from './game/levelRegistry.js';

// 开始页示例巴士与游戏内视觉统一（同一 SVG 素材，纯视觉初始化）
document.querySelectorAll('.mini-bus').forEach((el) => {
  el.innerHTML = busSvgMarkup(2);
});

// 开始页关卡数文案以注册表为唯一来源（不硬编码关卡数量）
document.getElementById('start-foot').textContent = `${getLevelCount()} 个关卡 · 纯原创玩法演示`;

createController().init();
