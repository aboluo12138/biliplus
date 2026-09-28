'use strict';

/**
 * 火狐（Firefox）扩展打包的共享逻辑。
 *
 * 这里做三件事：
 * 1. 校验 manifest.firefox.json：结构、资源引用、权限、与 Chrome 清单的功能对等；
 * 2. 组装可直接加载的未打包目录；
 * 3. 生成 ZIP（.zip / .xpi），不依赖任何第三方库或系统 zip 命令。
 *
 * 被 tools/build-firefox.cjs（命令行）和 tests/firefox-port.test.js（测试）复用。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const FIREFOX_MANIFEST = 'manifest.firefox.json';
const CHROME_MANIFEST = 'manifest.json';

/** 需要进入火狐扩展包的内容（相对仓库根目录）。 */
const PACKAGE_ENTRIES = Object.freeze([
  'css',
  'scripts',
  'settings',
  'img',
  'logo.png',
  'LICENSE',
]);

/**
 * 不进入火狐包的仓库文件：
 * - Chrome 专用后台入口（火狐清单用 background.scripts，引用它会误导排查）；
 * - README 用的截图与源图（体积大且与扩展运行无关，上架审核也不需要）。
 */
const PACKAGE_EXCLUDES = Object.freeze([
  'scripts/background/service-worker.js',
  'img/screenshot.png',
  'img/screenshot2.png',
  'img/logo_128.png',
]);

/** 系统垃圾文件一律不进包。 */
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function isPackaged(relativePath) {
  const normalized = toPosix(relativePath);
  if (PACKAGE_EXCLUDES.includes(normalized)) return false;
  const basename = normalized.split('/').pop();
  return !IGNORED_BASENAMES.has(basename);
}

/** 火狐兼容层，必须最先注入每个执行环境。 */
const COMPAT_SCRIPT = 'scripts/common/ext-api-compat.js';

/**
 * Firefox 156 扩展 schema 中确认存在的权限名。
 * 用白名单而不是黑名单，是为了在有人误加 Chrome 专有权限时立刻报错，
 * 而不是等用户安装后才发现功能静默失效。
 */
const FIREFOX_PERMISSIONS = new Set([
  'activeTab',
  'alarms',
  'bookmarks',
  'browserSettings',
  'browsingData',
  'clipboardRead',
  'clipboardWrite',
  'contextualIdentities',
  'cookies',
  'declarativeNetRequest',
  'declarativeNetRequestFeedback',
  'declarativeNetRequestWithHostAccess',
  'dns',
  'downloads',
  'find',
  'geolocation',
  'history',
  'identity',
  'idle',
  'management',
  'menus',
  'nativeMessaging',
  'notifications',
  'pkcs11',
  'privacy',
  'proxy',
  'scripting',
  'search',
  'sessions',
  'storage',
  'tabHide',
  'tabs',
  'theme',
  'topSites',
  'unlimitedStorage',
  'userScripts',
  'webNavigation',
  'webRequest',
  'webRequestBlocking',
]);

const MATCH_PATTERN = /^(\*|https?|file|ftp|moz-extension):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/;

/**
 * browser_specific_settings.gecko.data_collection_permissions 的合法取值。
 * 取自火狐自带 schema（chrome/toolkit/content/extensions/schemas/manifest.json
 * 里的 DataCollectionPermission / OptionalDataCollectionPermission 定义）。
 */
const DATA_COLLECTION_PERMISSIONS = new Set([
  'none',
  'authenticationInfo',
  'bookmarksInfo',
  'browsingActivity',
  'financialAndPaymentInfo',
  'healthInfo',
  'locationInfo',
  'personalCommunications',
  'personallyIdentifyingInfo',
  'searchTerms',
  'websiteActivity',
  'websiteContent',
]);

/** optional 比 required 多一个 technicalAndInteraction，且没有 none。 */
const OPTIONAL_DATA_COLLECTION_PERMISSIONS = new Set(
  [...DATA_COLLECTION_PERMISSIONS].filter(value => value !== 'none').concat('technicalAndInteraction')
);

function parseMatchPattern(pattern) {
  const match = /^(\*|https?|file|ftp|moz-extension):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(
    pattern
  );
  if (!match) return null;
  return { scheme: match[1], host: match[2], path: match[3] };
}

/**
 * a 是否完全覆盖 b（b 落在 a 的范围内）。只处理扩展清单里实际会用的写法：
 * 左侧路径必须是 /*（覆盖该来源下的任意路径），主机支持 `*`、`*.domain` 与具体域名。
 */
function matchPatternSubsumes(a, b) {
  const left = parseMatchPattern(a);
  const right = parseMatchPattern(b);
  if (!left || !right) return false;
  if (left.path !== '/*') return false;
  if (left.scheme !== '*' && left.scheme !== right.scheme) return false;
  if (left.host === '*') return true;
  if (left.host.startsWith('*.')) {
    const base = left.host.slice(2);
    return right.host === base || right.host.endsWith(`.${base}`);
  }
  return left.host === right.host;
}

/** 找出被同组内其它条目完全覆盖的冗余权限。 */
function findRedundantHostPermissions(patterns) {
  return patterns.filter((pattern, index) =>
    patterns.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && matchPatternSubsumes(candidate, pattern)
    )
  );
}

/** 找出未被 required 覆盖的 required 之外的主机权限（用于与 Chrome 清单对等）。 */
function findUncoveredHostPermissions(required, available) {
  return required.filter(
    pattern => !available.some(candidate => matchPatternSubsumes(candidate, pattern))
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function relativeManifestFiles(manifest) {
  const files = [
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    manifest.background?.page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ];
  for (const contentScript of manifest.content_scripts || []) {
    files.push(...(contentScript.js || []), ...(contentScript.css || []));
  }
  if (manifest.background?.scripts) {
    files.push(...manifest.background.scripts);
  }
  if (manifest.background?.service_worker) {
    files.push(manifest.background.service_worker);
  }
  return files.filter(value => typeof value === 'string' && value.length > 0);
}

/**
 * 校验火狐清单。返回 { errors, warnings }，errors 非空时不应打包。
 */
function validateFirefoxManifest(options = {}) {
  const root = options.root || ROOT;
  const errors = [];
  const warnings = [];

  const manifestPath = path.join(root, FIREFOX_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { errors: [`缺少 ${FIREFOX_MANIFEST}`], warnings };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return { errors: [`${FIREFOX_MANIFEST} 不是合法 JSON：${error.message}`], warnings };
  }

  const chromeManifestPath = path.join(root, CHROME_MANIFEST);
  const chromeManifest = fs.existsSync(chromeManifestPath)
    ? readJson(chromeManifestPath)
    : null;

  if (manifest.manifest_version !== 3) {
    errors.push('manifest_version 必须为 3');
  }

  // --- 版本号 -------------------------------------------------------------
  // 版本号以 Chrome 清单为唯一来源，打包时会自动同步进火狐包（见
  // resolveManifestForPackage）。所以这里只提示、不报错——上游升版本后
  // 不需要手工改 manifest.firefox.json。
  if (chromeManifest && manifest.version !== chromeManifest.version) {
    warnings.push(
      `${FIREFOX_MANIFEST} 的 version（${manifest.version}）与 ${CHROME_MANIFEST}` +
        `（${chromeManifest.version}）不一致，打包时会自动同步为后者`
    );
  }
  const versionFile = path.join(root, 'version.txt');
  if (fs.existsSync(versionFile) && chromeManifest) {
    const declared = fs.readFileSync(versionFile, 'utf8').trim();
    if (declared !== chromeManifest.version) {
      errors.push(
        `版本不一致：version.txt 为 ${declared}，${CHROME_MANIFEST} 为 ${chromeManifest.version}`
      );
    }
  }

  // --- 火狐必需的身份信息 -------------------------------------------------
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko || typeof gecko.id !== 'string' || gecko.id.length === 0) {
    errors.push('缺少 browser_specific_settings.gecko.id（火狐必须显式声明扩展 ID）');
  }
  if (typeof gecko?.strict_min_version !== 'string') {
    errors.push('缺少 browser_specific_settings.gecko.strict_min_version');
  } else {
    // data_collection_permissions 是 Firefox 140 才支持的键；strict_min_version
    // 低于它时 AMO 会报 "Manifest key not supported by the specified minimum
    // Firefox version"。Android 侧要求 142。
    const desktopMin = Number.parseFloat(gecko.strict_min_version);
    if (Number.isFinite(desktopMin) && desktopMin < 140) {
      errors.push(
        `strict_min_version 应 >= 140.0（data_collection_permissions 需要 Firefox 140+），` +
          `当前为 ${gecko.strict_min_version}`
      );
    }
  }

  const geckoAndroid = manifest.browser_specific_settings?.gecko_android;
  if (!geckoAndroid) {
    warnings.push(
      '未声明 browser_specific_settings.gecko_android，AMO 会按桌面版最低版本要求 Android（142+）并给出提示'
    );
  } else {
    const androidMin = Number.parseFloat(geckoAndroid.strict_min_version);
    if (!Number.isFinite(androidMin) || androidMin < 142) {
      errors.push(
        `gecko_android.strict_min_version 应 >= 142.0（data_collection_permissions 的 Android 要求），` +
          `当前为 ${geckoAndroid.strict_min_version}`
      );
    }
  }

  // AMO 强制要求声明数据收集用途，缺了会被直接拒收。
  const dataCollection = gecko?.data_collection_permissions;
  if (
    !dataCollection ||
    !Array.isArray(dataCollection.required) ||
    dataCollection.required.length === 0
  ) {
    errors.push(
      '缺少 browser_specific_settings.gecko.data_collection_permissions.required（AMO 强制要求）'
    );
  } else {
    for (const value of dataCollection.required) {
      if (!DATA_COLLECTION_PERMISSIONS.has(value)) {
        errors.push(`data_collection_permissions.required 含未知取值："${value}"`);
      }
    }
    // 语义上 "none" 表示不收集任何数据，与具体类别并列没有意义。
    // 火狐本身只警告并忽略 "none"（见 Schemas.sys.mjs 的
    // checkValidRequiredDataCollection），这里保持一致，用警告而非报错。
    if (dataCollection.required.includes('none') && dataCollection.required.length > 1) {
      warnings.push(
        'data_collection_permissions.required 同时含 "none" 与其它类别：' +
          '火狐会忽略 "none"，建议只保留其一'
      );
    }
    for (const value of dataCollection.optional || []) {
      if (!OPTIONAL_DATA_COLLECTION_PERMISSIONS.has(value)) {
        errors.push(`data_collection_permissions.optional 含未知取值："${value}"`);
      }
    }
  }

  // --- 后台：事件页而不是 Service Worker ---------------------------------
  const background = manifest.background || {};
  if (background.service_worker) {
    errors.push(
      '火狐清单不能使用 background.service_worker，应改用 background.scripts（事件页）'
    );
  }
  const backgroundScripts = background.scripts;
  if (!Array.isArray(backgroundScripts) || backgroundScripts.length === 0) {
    errors.push('background.scripts 必须是非空数组');
  } else {
    if (backgroundScripts[0] !== COMPAT_SCRIPT) {
      errors.push(`background.scripts 的第一项必须是 ${COMPAT_SCRIPT}`);
    }
    for (const required of [
      'scripts/background/information-cocoon.js',
      'scripts/background/archive-proxy.js',
      'scripts/background/firefox-background.js',
    ]) {
      if (!backgroundScripts.includes(required)) {
        errors.push(`background.scripts 缺少 ${required}`);
      }
    }
    const firefoxEntry = backgroundScripts.indexOf('scripts/background/firefox-background.js');
    if (firefoxEntry !== -1 && firefoxEntry !== backgroundScripts.length - 1) {
      errors.push('firefox-background.js 必须最后加载，以便检测其它后台模块是否成功');
    }
  }

  // --- 内容脚本：兼容层先行 ----------------------------------------------
  const contentScripts = manifest.content_scripts;
  if (!Array.isArray(contentScripts) || contentScripts.length === 0) {
    errors.push('content_scripts 必须是非空数组');
  } else {
    contentScripts.forEach((contentScript, index) => {
      if (contentScript.js?.[0] !== COMPAT_SCRIPT) {
        errors.push(`content_scripts[${index}].js 的第一项必须是 ${COMPAT_SCRIPT}`);
      }
      if (!Array.isArray(contentScript.matches) || contentScript.matches.length === 0) {
        errors.push(`content_scripts[${index}] 缺少 matches`);
      }
    });
  }

  // --- 权限 ---------------------------------------------------------------
  for (const permission of manifest.permissions || []) {
    if (!FIREFOX_PERMISSIONS.has(permission)) {
      errors.push(`权限 "${permission}" 不在火狐可用权限白名单内，请确认是否 Chrome 专有`);
    }
  }
  for (const pattern of [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ]) {
    if (!MATCH_PATTERN.test(pattern)) {
      errors.push(`主机权限格式可疑："${pattern}"`);
    }
  }
  for (const pattern of manifest.optional_host_permissions || []) {
    if ((manifest.host_permissions || []).includes(pattern)) {
      errors.push(`可选主机权限不应与必需主机权限重复："${pattern}"`);
    }
  }
  // 被同组内其它条目完全覆盖的条目是纯噪音：火狐会把每一条都当成一个可授权项
  // 展示给用户（origin controls），用户会以为要逐个打开。
  for (const pattern of findRedundantHostPermissions(manifest.host_permissions || [])) {
    errors.push(
      `host_permissions 中的 "${pattern}" 已被更宽的条目覆盖，属于冗余，请删除`
    );
  }
  for (const pattern of findRedundantHostPermissions(manifest.optional_host_permissions || [])) {
    errors.push(
      `optional_host_permissions 中的 "${pattern}" 已被更宽的条目覆盖，属于冗余，请删除`
    );
  }

  // --- 火狐 MV3 的站点授权模型 -------------------------------------------
  // Firefox 对 MV3 扩展默认不授予主机权限（origin controls），
  // 因此内容脚本要能工作，B 站域名必须出现在 host_permissions 中。
  const coversBilibili = (manifest.host_permissions || []).some(pattern =>
    pattern.includes('bilibili.com')
  );
  if (!coversBilibili) {
    errors.push('host_permissions 必须包含 B 站域名，否则火狐 MV3 下内容脚本无法运行');
  }

  // --- 图标与页面 ---------------------------------------------------------
  if (typeof manifest.action?.default_icon === 'string') {
    warnings.push('action.default_icon 建议使用尺寸对象，字符串形式在火狐上兼容性较差');
  }

  // --- 资源存在性 ---------------------------------------------------------
  for (const relativePath of new Set(relativeManifestFiles(manifest))) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      errors.push(`清单引用的文件不存在：${relativePath}`);
    }
  }

  // --- 与 Chrome 清单的功能对等 ------------------------------------------
  if (chromeManifest) {
    const chromeScripts = new Set();
    const chromeStyles = new Set();
    const chromeMatches = new Set();
    for (const contentScript of chromeManifest.content_scripts || []) {
      for (const file of contentScript.js || []) chromeScripts.add(file);
      for (const file of contentScript.css || []) chromeStyles.add(file);
      for (const match of contentScript.matches || []) chromeMatches.add(match);
    }
    const firefoxScripts = new Set();
    const firefoxStyles = new Set();
    const firefoxMatches = new Set();
    for (const contentScript of contentScripts || []) {
      for (const file of contentScript.js || []) firefoxScripts.add(file);
      for (const file of contentScript.css || []) firefoxStyles.add(file);
      for (const match of contentScript.matches || []) firefoxMatches.add(match);
    }

    for (const file of chromeScripts) {
      if (!firefoxScripts.has(file)) {
        errors.push(`Chrome 清单注入了 ${file}，火狐清单缺少对应注入`);
      }
    }
    for (const file of chromeStyles) {
      if (!firefoxStyles.has(file)) {
        errors.push(`Chrome 清单注入了 ${file}，火狐清单缺少对应样式`);
      }
    }
    for (const match of chromeMatches) {
      if (!firefoxMatches.has(match)) {
        errors.push(`火狐清单缺少 Chrome 清单中的匹配规则：${match}`);
      }
    }
    for (const permission of chromeManifest.permissions || []) {
      if (!(manifest.permissions || []).includes(permission)) {
        errors.push(`火狐清单缺少 Chrome 清单中的权限：${permission}`);
      }
    }
    for (const origin of chromeManifest.optional_host_permissions || []) {
      if (!(manifest.optional_host_permissions || []).includes(origin)) {
        errors.push(`火狐清单缺少 Chrome 清单中的可选主机权限：${origin}`);
      }
    }
    // 火狐用的条目可以比 Chrome 更宽（少而宽，避免用户在 origin controls 里
    // 看到一堆互相覆盖的开关），但必须真的覆盖住 Chrome 的每一条。
    for (const origin of findUncoveredHostPermissions(
      chromeManifest.host_permissions || [],
      manifest.host_permissions || []
    )) {
      errors.push(`火狐清单的 host_permissions 未覆盖 Chrome 清单中的：${origin}`);
    }
    if (chromeManifest.action?.default_popup !== manifest.action?.default_popup) {
      errors.push('弹窗页面与 Chrome 清单不一致');
    }
    if (chromeManifest.options_ui?.page !== manifest.options_ui?.page) {
      errors.push('设置页面与 Chrome 清单不一致');
    }
  } else {
    warnings.push(`未找到 ${CHROME_MANIFEST}，跳过与 Chrome 清单的对等校验`);
  }

  return { errors, warnings };
}

// --- 最小 ZIP 写入 --------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function toDosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * 生成 ZIP 缓冲。files: [{ name, data }]，name 使用 / 分隔。
 */
function createZip(files, options = {}) {
  const now = options.date || new Date();
  const { time, date } = toDosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 名称
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

// --- 组装发布物 -----------------------------------------------------------

function copyEntry(root, relativePath, destinationRoot) {
  const source = path.join(root, relativePath);
  if (!fs.existsSync(source)) {
    throw new Error(`打包内容不存在：${relativePath}`);
  }
  const target = path.join(destinationRoot, relativePath);
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of listFiles(source)) {
      const relativeToSource = path.relative(source, file);
      if (!isPackaged(`${relativePath}/${toPosix(relativeToSource)}`)) continue;
      const targetFile = path.join(target, relativeToSource);
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(file, targetFile);
    }
    return;
  }
  if (!isPackaged(relativePath)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

/**
 * 生成用于打包的火狐清单：以 manifest.firefox.json 为模板，版本号从
 * manifest.json 同步。这样上游升版本后不需要手工维护第二份版本号。
 */
function resolveManifestForPackage(root) {
  const manifest = readJson(path.join(root, FIREFOX_MANIFEST));
  const chromeManifestPath = path.join(root, CHROME_MANIFEST);
  if (fs.existsSync(chromeManifestPath)) {
    const chromeManifest = readJson(chromeManifestPath);
    if (typeof chromeManifest.version === 'string') {
      manifest.version = chromeManifest.version;
    }
  }
  return manifest;
}

/**
 * 把火狐扩展组装到 unpackedDir，并生成 zip/xpi。
 */
function buildFirefoxPackage(options = {}) {
  const root = options.root || ROOT;
  const outDir = options.outDir || path.join(root, 'dist');
  const unpackedDir = options.unpackedDir || path.join(outDir, 'firefox');
  const writeArchives = options.archives !== false;

  const manifest = resolveManifestForPackage(root);
  fs.rmSync(unpackedDir, { recursive: true, force: true });
  fs.mkdirSync(unpackedDir, { recursive: true });

  for (const entry of PACKAGE_ENTRIES) {
    copyEntry(root, entry, unpackedDir);
  }
  // 火狐包内的清单位于根部，文件名必须是 manifest.json。
  fs.writeFileSync(
    path.join(unpackedDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  const packedFiles = listFiles(unpackedDir).map(file => ({
    name: toPosix(path.relative(unpackedDir, file)),
    data: fs.readFileSync(file),
  }));
  packedFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const result = {
    version: manifest.version,
    unpackedDir,
    files: packedFiles.map(file => file.name),
    archives: [],
    archiveErrors: [],
  };

  if (!writeArchives) return result;

  fs.mkdirSync(outDir, { recursive: true });
  const zipBuffer = createZip(packedFiles);
  const baseName = `biliplus-firefox-${manifest.version}`;
  for (const extension of ['zip', 'xpi']) {
    const target = path.join(outDir, `${baseName}.${extension}`);
    try {
      fs.writeFileSync(target, zipBuffer);
      result.archives.push(target);
    } catch (error) {
      // 最常见的原因是火狐正加载着上一次的包，文件被占用。
      result.archiveErrors.push(
        `${path.basename(target)} 写入失败（${error.code || error.message}）：` +
          '文件可能正被火狐加载，请先在 about:debugging 中移除该扩展再重试'
      );
    }
  }
  return result;
}

module.exports = {
  ROOT,
  FIREFOX_MANIFEST,
  CHROME_MANIFEST,
  PACKAGE_ENTRIES,
  PACKAGE_EXCLUDES,
  COMPAT_SCRIPT,
  FIREFOX_PERMISSIONS,
  DATA_COLLECTION_PERMISSIONS,
  OPTIONAL_DATA_COLLECTION_PERMISSIONS,
  isPackaged,
  parseMatchPattern,
  matchPatternSubsumes,
  findRedundantHostPermissions,
  findUncoveredHostPermissions,
  resolveManifestForPackage,
  validateFirefoxManifest,
  createZip,
  crc32,
  buildFirefoxPackage,
  listFiles,
  toPosix,
  readJson,
};
