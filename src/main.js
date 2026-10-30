/**
 * 《巴士大疏通》入口
 * 组装：核心逻辑(src/game) 与 渲染/控制(src/ui) 完全分离，
 * 本文件只负责启动控制器与首页主视觉素材注入。
 */
import { createController } from './ui/controller.js';
import { busSvgMarkup, catSvgMarkup, heroBusSvgMarkup } from './ui/render.js';
import { preloadBgm } from './ui/sound.js';

// 首页主视觉：黄色猫咪巴士车体（原创侧视 SVG）；
// 车窗与草坪上的猫咪复用游戏内猫头素材（.start-cat 容器注入）
const heroBusArt = document.querySelector('.hero-bus-art');
if (heroBusArt) heroBusArt.innerHTML = heroBusSvgMarkup();
document.querySelectorAll('.start-cat').forEach((el) => {
  el.innerHTML = catSvgMarkup();
});

// 内页面板标题图标：队列用猫头、停车场用巴士（与棋盘素材同源）
const queueIco = document.getElementById('queue-ico');
if (queueIco) queueIco.innerHTML = catSvgMarkup();
const boardIco = document.getElementById('board-ico');
if (boardIco) boardIco.innerHTML = busSvgMarkup(2);

createController().init();

// 首屏空闲时预取本地 BGM，点击「开始游戏」后可立即出声。
preloadBgm();
