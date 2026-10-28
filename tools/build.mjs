/**
 * 零依赖生产构建：把运行时需要的静态文件复制到 dist/。
 *
 * 本项目是纯前端 ES Modules，没有打包/转译需求，因此生产构建只需要：
 *  1. 清空 dist；
 *  2. 复制 index.html、src/、assets/（排除 .DS_Store 等系统文件）；
 *  3. 校验入口与关键资源齐全；
 *  4. 扫描部署产物中是否残留 localhost / file:// / 本机绝对路径。
 *
 * 用法：npm run build
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ENTRIES = ['index.html', 'src', 'assets'];

const REQUIRED = [
  'index.html',
  'src/main.js',
  'src/styles.css',
  'src/ui/controller.js',
  'src/ui/render.js',
  'src/ui/sound.js',
  'src/game/generatedLevels.js',
  'assets/bgm-cat-bus.wav',
  'assets/favicon.svg',
];

const TEXT_EXT = new Set(['.html', '.css', '.js', '.svg', '.json']);
const FORBIDDEN = [
  { re: /\blocalhost\b/i, label: 'localhost' },
  { re: /\b127\.0\.0\.1\b/, label: '127.0.0.1' },
  { re: /\bfile:\/\//i, label: 'file://' },
  { re: /\/Users\/[^/\s"']+/i, label: '本机绝对路径 /Users/' },
];

function shouldCopy(source) {
  const name = source.split(/[\\/]/).pop() || '';
  return name !== '.DS_Store' && !name.startsWith('._');
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!shouldCopy(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const entry of ENTRIES) {
    await cp(join(ROOT, entry), join(DIST, entry), {
      recursive: true,
      filter: shouldCopy,
    });
  }

  const missing = [];
  for (const file of REQUIRED) {
    try {
      const info = await stat(join(DIST, file));
      if (!info.isFile()) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  if (missing.length) {
    throw new Error(`构建产物缺少必要文件：\n  - ${missing.join('\n  - ')}`);
  }

  const problems = [];
  const files = await walk(DIST);
  let totalBytes = 0;
  for (const file of files) {
    const info = await stat(file);
    totalBytes += info.size;
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const text = await readFile(file, 'utf8');
    for (const rule of FORBIDDEN) {
      if (rule.re.test(text)) {
        problems.push(`${relative(DIST, file)} 含 ${rule.label}`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`构建产物含部署后会失效的引用：\n  - ${problems.join('\n  - ')}`);
  }

  console.log(`✅ 生产构建完成：dist/（${files.length} 个文件，${formatBytes(totalBytes)}）`);
  console.log('   入口：dist/index.html');
  console.log('   校验：入口/资源齐全，未发现 localhost、file:// 或本机绝对路径');
}

main().catch((error) => {
  console.error(`❌ 构建失败：${error.message}`);
  process.exitCode = 1;
});