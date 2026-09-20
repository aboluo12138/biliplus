#!/usr/bin/env node
'use strict';

/**
 * 构建火狐（Firefox）扩展包。
 *
 * 用法：
 *   node tools/build-firefox.cjs                    # 校验 + 生成 dist/ 与 zip/xpi
 *   node tools/build-firefox.cjs --unpacked-only    # 只生成可加载目录
 *   node tools/build-firefox.cjs --out dist-ff      # 指定输出目录
 *
 * 产物：
 *   <out>/firefox/                        未打包目录，可在 about:debugging 临时加载
 *   <out>/biliplus-firefox-<version>.zip  用于 AMO 上传或临时加载
 *   <out>/biliplus-firefox-<version>.xpi  同上（扩展名不同，方便直接分发）
 */

const path = require('node:path');
const {
  ROOT,
  validateFirefoxManifest,
  buildFirefoxPackage,
} = require('./firefox-package.cjs');

function parseArgs(argv) {
  const options = { outDir: path.join(ROOT, 'dist'), archives: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--unpacked-only') {
      options.archives = false;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out 需要一个目录参数');
      options.outDir = path.isAbsolute(value) ? value : path.join(ROOT, value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (options.help) {
    console.log(
      [
        '构建火狐扩展包',
        '',
        '  node tools/build-firefox.cjs [--out <dir>] [--unpacked-only]',
        '',
        '  --out <dir>        输出目录，默认 dist',
        '  --unpacked-only    只生成未打包目录，不生成 zip/xpi',
      ].join('\n')
    );
    return;
  }

  const { errors, warnings } = validateFirefoxManifest({ root: ROOT });

  for (const warning of warnings) {
    console.warn(`警告：${warning}`);
  }
  if (errors.length > 0) {
    console.error('火狐清单校验失败：');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const result = buildFirefoxPackage({
    root: ROOT,
    outDir: options.outDir,
    archives: options.archives,
  });

  console.log(`火狐扩展版本：${result.version}`);
  console.log(`未打包目录：${path.relative(ROOT, result.unpackedDir)}`);
  console.log(`文件数量：${result.files.length}`);
  for (const archive of result.archives) {
    console.log(`压缩包：${path.relative(ROOT, archive)}`);
  }
  for (const archiveError of result.archiveErrors) {
    console.error(`警告：${archiveError}`);
  }
  console.log('');
  console.log('本地加载方式：火狐打开 about:debugging#/runtime/this-firefox，');
  console.log('点击「临时载入附加组件」，选择 dist/firefox/manifest.json。');

  if (result.archiveErrors.length > 0 && result.archives.length === 0) {
    process.exit(1);
  }
}

main();
