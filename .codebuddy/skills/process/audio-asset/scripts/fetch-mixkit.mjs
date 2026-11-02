#!/usr/bin/env node
/**
 * fetch-mixkit.mjs — Mixkit 免费音频素材清单/下载工具（Node ≥18，零依赖）
 *
 * 站点直链规律（2026-11 实测）：
 * - 音效(SFX)：详情直链 = https://assets.mixkit.co/active_storage/sfx/{id}/{id}-preview.mp3
 *   （-preview 后缀的 mp3 就是完整音效，非试听片段）
 * - 音乐(BGM)：整曲直链 = https://assets.mixkit.co/music/{id}/{id}.mp3（无 -preview 后缀）
 * - 分类页 sfx：https://mixkit.co/free-sound-effects/{分类}/    （每页约 36 条）
 * - 分类页 music：https://mixkit.co/free-stock-music/tag/{tag}/ （每页约 16 条）
 *
 * 用法：
 *   node fetch-mixkit.mjs list sfx <分类名|完整URL> [关键词...]
 *   node fetch-mixkit.mjs list music <tag|完整URL> [关键词...]
 *   node fetch-mixkit.mjs download <输出目录> sfx <id>[=文件别名] [<id>[=文件别名] ...]
 *   node fetch-mixkit.mjs download <输出目录> music <id>[=文件别名] [<id>[=文件别名] ...]
 *
 * download 会在输出目录写入 manifest.json（含来源 URL / 许可 / 下载日期），供授权留档。
 * 许可：Mixkit Stock License —— 免费、可商用、无需署名。
 */
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const LICENSE = 'Mixkit Stock License (free, commercial use, no attribution)';

const getPage = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
};

/** 从 sfx 分类页解析 [id, 标题] 列表 */
const parseSfx = (html) => {
  const re = /data-audio-player-preview-url-value="(https:\/\/assets\.mixkit\.co\/active_storage\/sfx\/(\d+)\/\2-preview\.mp3)"[\s\S]{0,3000}?item-grid-card__title">([^<]+)</g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ id: m[2], title: m[3].trim(), url: m[1] });
  return out;
};

/** 从 music 分类页解析 [id, 标题] 列表（注意 music 页 URL 无 -preview 后缀） */
const parseMusic = (html) => {
  const re = /data-audio-player-preview-url-value="(https:\/\/assets\.mixkit\.co\/music\/(\d+)\/\2\.mp3)"[\s\S]{0,3000}?item-grid-card__title">([^<]+)</g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ id: m[2], title: m[3].trim(), url: m[1] });
  return out;
};

const listCmd = async (kind, target, keywords) => {
  const url = /^https?:\/\//.test(target)
    ? target
    : kind === 'sfx'
      ? `https://mixkit.co/free-sound-effects/${target}/`
      : `https://mixkit.co/free-stock-music/tag/${target}/`;
  const html = await getPage(url);
  const items = kind === 'sfx' ? parseSfx(html) : parseMusic(html);
  const kw = (keywords || []).map((k) => k.toLowerCase());
  const filtered = kw.length
    ? items.filter((it) => kw.some((k) => it.title.toLowerCase().includes(k)))
    : items;
  console.log(`# ${kind} @ ${url}  共 ${items.length} 条，显示 ${filtered.length} 条`);
  for (const it of filtered) console.log(`${it.id}\t${it.title}`);
  if (!filtered.length) console.log('#（无匹配——可去掉关键词看全量，或换分类/tag）');
};

const downloadCmd = async (dir, kind, specs) => {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const manifestPath = `${dir}/manifest.json`;
  const manifest = existsSync(manifestPath) ? JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(manifestPath, 'utf8'))) : [];
  for (const spec of specs) {
    const [idRaw, alias] = spec.split('=');
    const id = idRaw;
    const name = alias || id;
    const url = kind === 'sfx'
      ? `https://assets.mixkit.co/active_storage/sfx/${id}/${id}-preview.mp3`
      : `https://assets.mixkit.co/music/${id}/${id}.mp3`;
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) { console.log(`SKIP ${name}(${id}) HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const file = `${dir}/${name}.mp3`;
      writeFileSync(file, buf);
      manifest.push({ file: `${name}.mp3`, id, kind, title: name, url, license: LICENSE, downloadedAt: new Date().toISOString().slice(0, 10) });
      console.log(`OK   ${file}  ${(buf.length / 1024).toFixed(0)}KB  ${url}`);
    } catch (e) {
      console.log(`ERR  ${name}(${id}) ${e.message}`);
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`# manifest 已更新：${manifestPath}`);
};

const [, , cmd, ...args] = process.argv;
if (cmd === 'list') await listCmd(args[0], args[1], args.slice(2));
else if (cmd === 'download') await downloadCmd(args[0], args[1], args.slice(2));
else {
  console.log('用法:');
  console.log('  node fetch-mixkit.mjs list sfx <分类|URL> [关键词...]      例: list sfx water pour');
  console.log('  node fetch-mixkit.mjs list music <tag|URL> [关键词...]     例: list music game');
  console.log('  node fetch-mixkit.mjs download <目录> sfx <id>[=别名] ...  例: download ./out sfx 2826=pour 1124=tap');
  console.log('  node fetch-mixkit.mjs download <目录> music <id>[=别名] ...');
  process.exit(1);
}
