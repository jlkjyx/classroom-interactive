/**
 * 打包部署包。
 *
 * 只打运行必需的文件：源码 + 生产依赖清单 + Dockerfile + 编排 + 指南。
 * 明确排除：node_modules、test/、shots/、data/、logs/、.git。
 * 这些要么体积大，要么带本机数据，传到服务器上只会添乱。
 *
 * 用法：npm run pack
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deploy', 'classroom-interactive-deploy.zip');
const STAGE = join(ROOT, '.pack-tmp');

/** 需要打包的文件：相对项目根目录 → 包内路径。 */
const FILES = [
  ['Dockerfile', 'Dockerfile'],
  ['.dockerignore', '.dockerignore'],
  ['docker-compose.yml', 'docker-compose.yml'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['README.md', 'README.md'],
  ['部署指南-1Panel.md', '部署指南-1Panel.md'],
  ['部署指南-1Panel-Docker.md', '部署指南-1Panel-Docker.md'],
  ['server/index.js', 'server/index.js'],
  ['server/state.js', 'server/state.js'],
  ['public/control.html', 'public/control.html'],
  ['public/favicon.svg', 'public/favicon.svg'],
  ['public/index.html', 'public/index.html'],
  ['public/mobile.html', 'public/mobile.html'],
  ['public/wall.html', 'public/wall.html'],
  ['public/css/base.css', 'public/css/base.css'],
  ['public/css/control.css', 'public/css/control.css'],
  ['public/css/mobile.css', 'public/css/mobile.css'],
  ['public/css/wall.css', 'public/css/wall.css'],
  ['public/js/common.js', 'public/js/common.js'],
  ['public/js/control.js', 'public/js/control.js'],
  ['public/js/mobile.js', 'public/js/mobile.js'],
  ['public/js/viz-danmaku.js', 'public/js/viz-danmaku.js'],
  ['public/js/viz-misc.js', 'public/js/viz-misc.js'],
  ['public/js/viz-wheel.js', 'public/js/viz-wheel.js'],
  ['public/js/viz-wordcloud.js', 'public/js/viz-wordcloud.js'],
  ['public/js/wall.js', 'public/js/wall.js'],
  // 编排给两份：主用（本地构建）、兜底（不构建，绕开 pull access denied）。
  //
  // 包内路径与仓库路径保持一致，不要为了「目录好看」把 deploy/docker/ 收敛成
  // docker/：指南里写的是「把 deploy/docker/docker-compose.yml 整段粘贴进去」，
  // 用户在服务器上解压后就是照着这个路径找文件的。路径一改，用户找不到文件，
  // 而这类不一致在打包机上根本发现不了。
  ['deploy/docker/docker-compose.yml', 'deploy/docker/docker-compose.yml'],
  ['deploy/docker/docker-compose.run.yml', 'deploy/docker/docker-compose.run.yml'],
  // 部署后在服务器上跑的自检脚本。它存在的理由见文件头注释：本项目吃过两次
  // 「以为部署成功、实际跑的是旧包」的亏，靠人肉核对版本号不可靠。
  ['scripts/selfcheck.sh', 'scripts/selfcheck.sh'],
];

const missing = FILES.filter(([src]) => !existsSync(join(ROOT, src)));
if (missing.length) {
  console.error('以下文件缺失，打包中止：');
  missing.forEach(([src]) => console.error('  -', src));
  process.exit(1);
}

// 兜底自检：别把本机数据或测试产物带进包里。
const NOISE = /(^|\/)(node_modules|test|shots|data|logs)(\/|$)/;
const dirty = FILES.filter(([, dst]) => NOISE.test(dst));
if (dirty.length) {
  console.error('打包清单里混入了不该上传的目录：', dirty.map(([, d]) => d));
  process.exit(1);
}

// 用临时目录搭出包内结构，再整体压缩。
//
// 必须先清空再拷：改过打包清单后，旧的中间产物会留在里面被一起压进去
// （实测改路径映射时就撞上了：包里同时出现新旧两套路径）。
// 这里走外部命令删除而不是 fs.rmSync —— 某些环境把 rmSync 接到回收站实现上，
// 会超时抛异常把脚本打断。删不掉也不能静默继续：下面的清单比对会抓出来。
function cleanStage() {
  if (!existsSync(STAGE)) return;
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Remove-Item -LiteralPath '${STAGE}' -Recurse -Force -ErrorAction Stop`],
      { stdio: 'ignore' },
    );
  } catch {
    // 交给下面的文件数比对去报错，这里不吞问题
  }
}

cleanStage();
FILES.forEach(([src, dst]) => {
  const to = join(STAGE, dst);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, src), to);
});

mkdirSync(dirname(OUT), { recursive: true });

const rel = (p) => relative(ROOT, p).replace(/\//g, '\\');

try {
  // 用 PowerShell 的 Compress-Archive：Windows 自带，不用装 zip。
  // 压缩 STAGE 的内容（不是 STAGE 本身），这样包内没有多余一层目录。
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${OUT}' -Force`,
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
} catch (e) {
  console.error('打包失败。', e.message);
  process.exit(1);
}

// Compress-Archive 有时会「静默失败」：退出码非 0、不报错，但产物是个几十字节
// 的空 zip（上传上去才发现，排查方向会整个跑偏）。这里用体积做一道粗筛，
// 并且把回读校验的命令直接打出来，省得用户自己想。
if (!existsSync(OUT) || statSync(OUT).size < 2048) {
  console.error(`\n产物异常（${existsSync(OUT) ? statSync(OUT).size : 0} 字节），未生成有效压缩包。`);
  console.error(`临时目录 ${rel(STAGE)} 已保留，可直接用 Python 打包：`);
  console.error(`  python -c "import os,zipfile;z=zipfile.ZipFile('deploy/classroom-interactive-deploy.zip','w',zipfile.ZIP_DEFLATED);[z.write(os.path.join(d,f),os.path.relpath(os.path.join(d,f),'.pack-tmp')) for d,_,fs in os.walk('.pack-tmp') for f in fs];z.close()"`);
  process.exit(1);
}

const kb = (statSync(OUT).size / 1024).toFixed(1);
console.log(`\n已生成 ${rel(OUT)}`);
console.log(`  ${FILES.length} 个文件 / ${kb} KB`);

// 包内自查：把临时目录里实际的东西列一遍。
// 真正的风险不是漏文件，而是多带了本机数据（data/ 里的课堂快照、logs/、
// node_modules）。压缩前看一眼，比传上去才发现强。
const walked = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else walked.push(relative(STAGE, p).replace(/\\/g, '/'));
  }
})(STAGE);

const leaked = walked.filter((p) => NOISE.test(p));
if (leaked.length) {
  console.error('\n包内混入了不该上传的内容：');
  leaked.forEach((p) => console.error('  -', p));
  process.exit(1);
}
// 不一致时把多出来/少了的直接列出来。改过打包清单后最常见的情况是
// 旧路径的残留没清掉，不点名的话用户根本不知道多的是哪几个。
if (walked.length !== FILES.length) {
  const want = new Set(FILES.map(([, dst]) => dst));
  const extra = walked.filter((p) => !want.has(p));
  const gone = [...want].filter((p) => !walked.includes(p));
  console.error(`\n包内文件数 ${walked.length}，与清单 ${FILES.length} 不一致。`);
  if (extra.length) {
    console.error('  多出来（多半是上次打包的残留）：');
    extra.forEach((p) => console.error('    +', p));
    console.error(`  删掉 ${rel(STAGE)} 目录后重跑即可。`);
  }
  if (gone.length) {
    console.error('  缺失：');
    gone.forEach((p) => console.error('    -', p));
  }
  process.exit(1);
}

console.log('\n包内清单：');
walked.sort().forEach((p) => console.log('  ', p));
console.log('\n上传到服务器 /opt 下解压，目录名保持 classroom-interactive。');
