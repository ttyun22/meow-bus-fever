/**
 * 《巴士大疏通》入口
 * 组装：核心逻辑(src/game) 与 渲染/控制(src/ui) 完全分离，
 * 本文件只负责启动控制器与开始页示例素材注入。
 */
import { createController } from './ui/controller.js';
import { busSvgMarkup, catSvgMarkup } from './ui/render.js';
import { preloadBgm } from './ui/sound.js';

// 开始页示例巴士/猫咪与游戏内视觉统一（同一 SVG 素材，纯视觉初始化）
document.querySelectorAll('.mini-bus').forEach((el) => {
  el.innerHTML = busSvgMarkup(2);
});
document.querySelectorAll('.start-cat').forEach((el) => {
  el.innerHTML = catSvgMarkup();
});

createController().init();

// 首屏空闲时预取本地 BGM，点击「开始游戏」后可立即出声。
preloadBgm();
