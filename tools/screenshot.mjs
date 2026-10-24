/**
 * 自动化截图：用 miniprogram-automator 拉起小游戏，驱动各场景并截屏。
 *
 * 前置条件：
 * 1. 微信开发者工具已安装（CLI 路径见下）
 * 2. 工具已开启「设置 → 安全设置 → 服务端口」
 *
 * 运行：npm run screenshot   （或 node tools/screenshot.mjs）
 * 产物：screenshots/*.png
 */
import automator from 'miniprogram-automator';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CLI_PATH = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT_PATH = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const OUT_DIR = 'screenshots';
const AUTO_PORT = 9420;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 拉起开发者工具自动化端口并连接。
 * 不用 automator.launch：其内部 spawn(.bat) 在 Node 20+ 被安全限制拒绝（EINVAL），
 * 故自行经 shell 启动 CLI，再用 automator.connect 接管。
 */
async function launchAndConnect() {
  let lastOutput = '';
  const child = spawn(
    CLI_PATH,
    ['auto', '--project', PROJECT_PATH, '--auto-port', String(AUTO_PORT)],
    { shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout.on('data', (d) => (lastOutput += d));
  child.stderr.on('data', (d) => (lastOutput += d));
  child.on('error', (err) => (lastOutput += `\n${err.message}`));

  for (let i = 0; i < 45; i++) {
    try {
      return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${AUTO_PORT}` });
    } catch (e) {
      await sleep(2000);
    }
  }
  throw new Error(
    `无法连接自动化端口 ${AUTO_PORT}。\ncli 输出: ${lastOutput.trim() || '(无)'}\n` +
      '请确认开发者工具「设置 → 安全设置 → 服务端口」已开启'
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('正在拉起微信开发者工具（首次可能较慢）...');
  const mp = await launchAndConnect();
  console.log('已连接小游戏');

  try {
    await sleep(4000); // 等待游戏初始化与首帧渲染
    await mp.screenshot({ path: `${OUT_DIR}/1-menu.png` });
    console.log('OK 菜单页');

    // 关卡选择页
    await mp.evaluate(() => GameGlobal.main.openLevelSelect());
    await sleep(800);
    await mp.screenshot({ path: `${OUT_DIR}/2-level-select.png` });
    console.log('OK 关卡选择页');

    // 进入第 1 关
    await mp.evaluate(() => GameGlobal.main.selectLevel(0));
    await sleep(1500);
    await mp.screenshot({ path: `${OUT_DIR}/3-game.png` });
    console.log('OK 游戏页');

    // 模拟倒一步水（选中源瓶 → 点合法目标）
    await mp.evaluate(() => {
      const m = GameGlobal.main;
      const from = m.logic.bottles.findIndex((b) => b.length > 0);
      let to = -1;
      for (let i = 0; i < m.logic.bottles.length; i++) {
        if (i !== from && m.logic.canPour(from, i) > 0) {
          to = i;
          break;
        }
      }
      if (to >= 0) {
        m.selected = from;
        m.tapBottle(to);
      }
    });
    await sleep(1800);
    await mp.screenshot({ path: `${OUT_DIR}/4-game-pour.png` });
    console.log('OK 倒水后');

    // 设置页
    await mp.evaluate(() => {
      GameGlobal.main.scene = 'settings';
    });
    await sleep(600);
    await mp.screenshot({ path: `${OUT_DIR}/5-settings.png` });
    console.log('OK 设置页');
  } finally {
    await mp.close();
    console.log(`完成，截图已保存到 ${OUT_DIR}/`);
  }
}

main().catch((err) => {
  console.error('截图失败:', err.message);
  console.error('若提示无法连接：请确认开发者工具「设置 → 安全设置 → 服务端口」已开启');
  process.exit(1);
});
