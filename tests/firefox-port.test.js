const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const {
  ROOT,
  CHROME_MANIFEST,
  COMPAT_SCRIPT,
  FIREFOX_MANIFEST,
  validateFirefoxManifest,
  createZip,
  buildFirefoxPackage,
  listFiles,
  readJson,
  resolveManifestForPackage,
  matchPatternSubsumes,
  findRedundantHostPermissions,
  findUncoveredHostPermissions,
} = require('../tools/firefox-package.cjs');

const firefoxManifest = readJson(path.join(ROOT, FIREFOX_MANIFEST));
const chromeManifest = readJson(path.join(ROOT, CHROME_MANIFEST));
const compatSource = fs.readFileSync(path.join(ROOT, COMPAT_SCRIPT), 'utf8');

/**
 * 模拟 Firefox 的扩展 API 环境。
 *
 * 关键点：Firefox 的 chrome.* 是「Chrome 兼容模式」——调用方不传回调时，
 * Firefox 内部会补一个空回调（Schemas.sys.mjs 的 isChromeCompat 分支），
 * 所以异步调用永远返回 undefined；而 browser.* 才返回 Promise。
 * 这个 mock 必须忠实复现该差异，否则测试就没有意义。
 */
function createFirefoxEnv() {
  const store = { 'biliplus-enable': true };
  const chromeCalls = [];
  const browserCalls = [];

  const makeImpl = () => ({
    storageSyncGet: keys => {
      const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys];
      const result = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
      }
      return result;
    },
    storageSyncSet: values => {
      Object.assign(store, values);
      return undefined;
    },
    sendMessage: message => {
      if (message?.fail) throw new Error('Could not establish connection.');
      return { ok: true, echoed: message };
    },
    permissionsContains: () => true,
    permissionsRequest: () => true,
    permissionsRemove: () => true,
    getDynamicRules: () => [{ id: 12001 }],
    updateDynamicRules: () => undefined,
    testMatchOutcome: () => ({ matchedRules: [{ ruleId: 12001 }] }),
    getManifest: () => ({ version: '1.2.0' }),
  });

  const impl = makeImpl();

  // Chrome 兼容模式：始终返回 undefined，结果只通过回调交付。
  const chromeMode = (label, fn) => {
    const wrapper = (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const deliver = callback || (() => {});
      chromeCalls.push(label);
      Promise.resolve()
        .then(() => fn(...args))
        .then(
          value => deliver(value),
          error => {
            chrome.runtime.lastError = { message: error.message };
            deliver();
            chrome.runtime.lastError = undefined;
          }
        );
      return undefined;
    };
    return wrapper;
  };

  const browserMode = (label, fn) => {
    const wrapper = (...args) => {
      browserCalls.push(label);
      return Promise.resolve().then(() => fn(...args));
    };
    return wrapper;
  };

  const buildNamespaces = mode => ({
    storage: {
      sync: {
        get: mode('storage.sync.get', impl.storageSyncGet),
        set: mode('storage.sync.set', impl.storageSyncSet),
      },
      local: {
        get: mode('storage.local.get', impl.storageSyncGet),
        set: mode('storage.local.set', impl.storageSyncSet),
        remove: mode('storage.local.remove', () => undefined),
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'biliplus@0xlau.dev',
      lastError: undefined,
      sendMessage: mode('runtime.sendMessage', impl.sendMessage),
      getManifest: impl.getManifest,
      getURL: suffix => `moz-extension://test/${suffix}`,
      getBrowserInfo: () => Promise.resolve({ name: 'Firefox', version: '156.0' }),
      onMessage: { addListener() {} },
    },
    permissions: {
      contains: mode('permissions.contains', impl.permissionsContains),
      request: mode('permissions.request', impl.permissionsRequest),
      remove: mode('permissions.remove', impl.permissionsRemove),
    },
    tabs: {
      create: mode('tabs.create', () => ({ id: 1 })),
      sendMessage: mode('tabs.sendMessage', () => undefined),
      onUpdated: { addListener() {} },
    },
    declarativeNetRequest: {
      getDynamicRules: mode('declarativeNetRequest.getDynamicRules', impl.getDynamicRules),
      updateDynamicRules: mode('declarativeNetRequest.updateDynamicRules', impl.updateDynamicRules),
      testMatchOutcome: mode('declarativeNetRequest.testMatchOutcome', impl.testMatchOutcome),
    },
  });

  const chrome = buildNamespaces(chromeMode);
  const browser = buildNamespaces(browserMode);

  return { chrome, browser, chromeCalls, browserCalls, store };
}

function createCompatContext(env) {
  return vm.createContext({ chrome: env.chrome, browser: env.browser, console });
}

function runCompat(env, context = createCompatContext(env)) {
  vm.runInContext(compatSource, context, { filename: COMPAT_SCRIPT });
  return context;
}

/** 去掉整行注释与 JSDoc 块，避免注释里的示例影响审计。 */
function stripCommentLines(source) {
  return source
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/** 从源码中收集 chrome.* / chromeApi.* 调用，例如 ['storage','sync','get']。 */
function collectChromeApiCalls(source, file) {
  const calls = [];
  const startPattern = /\b(?:chrome|chromeApi)\s*\??\./g;
  let match;
  while ((match = startPattern.exec(source)) !== null) {
    let cursor = match.index + match[0].length;
    const chain = [];
    for (;;) {
      const segment = /^([A-Za-z_$][\w$]*)\s*(\??\.)?/.exec(source.slice(cursor));
      if (!segment) break;
      chain.push(segment[1]);
      cursor += segment[0].length;
      // 后面还有成员访问就继续往下走，否则当前标识符就是链尾。
      if (!segment[2]) break;
    }
    if (chain.length < 2) continue;
    // 链尾紧跟 "(" 才是方法调用；否则只是属性读取（如能力检测）。
    const isCall = source.slice(cursor).trimStart().startsWith('(');
    calls.push({ file, chain, isCall });
  }
  return calls;
}

function shippedScriptFiles() {
  const files = new Set();
  for (const contentScript of firefoxManifest.content_scripts) {
    for (const file of contentScript.js || []) files.add(file);
  }
  for (const file of firefoxManifest.background.scripts || []) files.add(file);
  for (const file of listFiles(path.join(ROOT, 'settings', 'js'))) {
    files.add(path.relative(ROOT, file).split(path.sep).join('/'));
  }
  return [...files].sort();
}

const EVENT_METHODS = new Set(['addListener', 'removeListener', 'hasListener']);

/**
 * 火狐对 Window 上这些方法做 WebIDL receiver 校验：只有「obj.method(...)」这种
 * 当场带 receiver 的调用才合法；裸调用 `method(...)`、或先取出再调用
 * `const f = obj.method; f()` 都会抛
 * "called on an object that does not implement interface Window"。
 * Chrome 对此宽松，所以这类写法只在火狐上暴露，必须在静态层面守住。
 */
const RECEIVER_SENSITIVE_METHODS = [
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'matchMedia',
];

function findReceiverViolations(source) {
  const violations = [];
  const pattern = new RegExp(`\\b(${RECEIVER_SENSITIVE_METHODS.join('|')})\\b`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    const before = source.slice(0, match.index);
    const called = /^\s*\(/.test(source.slice(match.index + name.length));
    const memberMatch = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(before);

    if (!memberMatch) {
      // 裸调用会以全局对象为 receiver，火狐会抛错；裸属性读取不构成风险。
      if (called) violations.push(`裸调用 ${name}()，必须写成 window.${name}(...)`);
      continue;
    }
    if (called) continue; // obj.method(...)：正确写法

    // 能力检测（typeof obj.method / if (!obj.method)）不会调用方法，不需要 receiver。
    const beforeMember = before.slice(0, memberMatch.index);
    const prefix = beforeMember.slice(beforeMember.lastIndexOf('\n') + 1);
    if (/(?:typeof\s|!\s*|if\s*\(\s*|while\s*\(\s*)$/.test(prefix)) continue;

    violations.push(
      `把 ${memberMatch[1]}.${name} 取出后再调用，必须直接写成 ${memberMatch[1]}.${name}(...)，否则火狐会丢 receiver`
    );
  }
  return violations;
}

test('火狐清单通过全部结构与对等校验', () => {
  const { errors, warnings } = validateFirefoxManifest({ root: ROOT });
  assert.deepEqual(errors, []);
  // 版本号以 manifest.json 为准、打包时自动同步，所以「版本不一致」只是提示。
  const unexpected = warnings.filter(warning => !warning.includes('打包时会自动同步'));
  assert.deepEqual(unexpected, []);
});

test('打包时版本号从 manifest.json 同步（上游升版本无需手改火狐清单）', () => {
  const tempRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'biliplus-ver-'));
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '9.9.9' })
    );
    fs.writeFileSync(
      path.join(tempRoot, FIREFOX_MANIFEST),
      JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'x' })
    );
    const resolved = resolveManifestForPackage(tempRoot);
    assert.equal(resolved.version, '9.9.9');
    // 其余字段保持火狐清单原样。
    assert.equal(resolved.name, 'x');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('兼容层在每个执行环境中最先加载', () => {
  assert.equal(firefoxManifest.background.scripts[0], COMPAT_SCRIPT);
  for (const contentScript of firefoxManifest.content_scripts) {
    assert.equal(contentScript.js[0], COMPAT_SCRIPT);
  }
  // 覆盖 settings 下所有页面：上游新增页面时这里会直接报出来，
  // 提示需要给新页面也挂上兼容层。
  const pages = listFiles(path.join(ROOT, 'settings')).filter(file => file.endsWith('.html'));
  assert.ok(pages.length > 0, '没有找到任何扩展页面');
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const localScripts = scripts.filter(src => !/^(?:https?:)?\/\//.test(src));
    if (localScripts.length === 0) continue;
    const relative = path.relative(ROOT, page).split(path.sep).join('/');
    const compatIndex = scripts.findIndex(src => src.includes('ext-api-compat.js'));
    assert.notEqual(compatIndex, -1, `${relative} 未引入火狐兼容层`);
    assert.equal(compatIndex, 0, `${relative} 的兼容层必须排在其它脚本之前`);
  }
});

test('设置页提供火狐站点授权入口，且只在火狐显示', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings/settings.html'), 'utf8');
  assert.match(html, /<div class="site-access" id="site-access" role="status" hidden>/);
  assert.match(html, /<button type="button" id="site-access-grant">/);

  const script = fs.readFileSync(path.join(ROOT, 'settings/js/settings.js'), 'utf8');
  // 必须限定火狐：Chrome 安装即授权，且 Chrome 清单里没有这条 origin，
  // 在 Chrome 上调 request() 会直接抛错。
  assert.match(script, /typeof browser !== 'undefined'/);
  assert.match(script, /getBrowserInfo/);
  assert.match(script, /SITE_ACCESS_ORIGINS/);
  assert.match(script, /\*:\/\/\*\.bilibili\.com\/\*/);
  assert.match(script, /chrome\.permissions\.request\(siteAccessRequest\(\)\)/);
  // 设置页的既有约定：不能用 element.disabled = true 锁死控件。
  assert.doesNotMatch(script, /element\.disabled\s*=\s*true/);
});

test('未加载兼容层时，火狐的 chrome.* 确实不返回 Promise', () => {
  const env = createFirefoxEnv();
  assert.equal(env.chrome.storage.sync.get(['biliplus-enable']), undefined);
  assert.equal(env.chrome.runtime.sendMessage({ type: 'x' }), undefined);
  assert.equal(env.chrome.permissions.contains({ origins: [] }), undefined);
});

test('加载兼容层后，Promise 风格调用在火狐上可用', async () => {
  const env = createFirefoxEnv();
  const context = runCompat(env);

  const report = context.__biliplusExtApiCompat;
  assert.ok(report, '兼容层未写入自检报告');
  // report 来自 vm 上下文（另一个 realm），因此按长度断言并打印内容。
  assert.equal(report.failed.length, 0, `未能改写的 API：${JSON.stringify([...report.failed])}`);
  assert.ok(report.applied.length > 0);

  const values = await env.chrome.storage.sync.get(['biliplus-enable']);
  assert.deepEqual(values, { 'biliplus-enable': true });

  await env.chrome.storage.sync.set({ 'hide-user-comment': [] });
  assert.deepEqual(env.store['hide-user-comment'], []);

  const response = await env.chrome.runtime.sendMessage({ type: 'biliplus-archive-fetch' });
  assert.equal(response.ok, true);

  assert.equal(await env.chrome.permissions.contains({ origins: [] }), true);

  const rules = await env.chrome.declarativeNetRequest.getDynamicRules();
  assert.deepEqual(rules, [{ id: 12001 }]);

  const outcome = await env.chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://x' });
  assert.deepEqual(outcome.matchedRules, [{ ruleId: 12001 }]);

  // 同步方法必须保持同步返回值，不能被包装成 Promise。
  assert.equal(env.chrome.runtime.getManifest().version, '1.2.0');
  assert.equal(env.chrome.runtime.getURL('a.js'), 'moz-extension://test/a.js');

  // Promise 风格调用应走 browser.*（火狐原生 Promise 实现）。
  assert.ok(env.browserCalls.includes('storage.sync.get'));
  assert.equal(env.chromeCalls.length, 0);
});

test('回调风格调用仍然走 chrome.*，保持 lastError 等 Chrome 语义', async () => {
  const env = createFirefoxEnv();
  runCompat(env);

  const received = await new Promise(resolve => {
    const returned = env.chrome.storage.sync.get(['biliplus-enable'], resolve);
    // 回调风格必须保持 chrome.* 的返回语义：Firefox 返回 undefined。
    assert.equal(returned, undefined);
  });
  assert.deepEqual(received, { 'biliplus-enable': true });
  assert.ok(env.chromeCalls.includes('storage.sync.get'));
  assert.equal(env.browserCalls.length, 0);

  // 失败时也应走 chrome 回调路径，并在回调里暴露 runtime.lastError。
  const lastError = await new Promise(resolve => {
    env.chrome.runtime.sendMessage({ fail: true }, () => resolve(env.chrome.runtime.lastError));
  });
  assert.equal(lastError?.message, 'Could not establish connection.');
});

test('兼容层幂等，且重复加载不会二次包装', () => {
  const env = createFirefoxEnv();
  const context = createCompatContext(env);
  runCompat(env, context);
  const wrappedOnce = env.chrome.storage.sync.get;
  const reportOnce = context.__biliplusExtApiCompat;

  runCompat(env, context);
  assert.equal(env.chrome.storage.sync.get, wrappedOnce);
  assert.equal(context.__biliplusExtApiCompat, reportOnce);
  assert.equal(context.__biliplusExtApiCompat.failed.length, 0);
});

test('注入探针先于所有提前返回：识别不出火狐时也要写上标记', () => {
  const attributes = {};
  const context = vm.createContext({
    browser: null, // 识别不出火狐（或其它浏览器）：兼容层会提前 return
    chrome: {},
    console,
    document: {
      documentElement: {
        getAttribute: name => (name in attributes ? attributes[name] : null),
        setAttribute: (name, value) => {
          attributes[name] = value;
        },
      },
      addEventListener: () => {
        throw new Error('不应注册兜底监听');
      },
    },
  });
  vm.runInContext(compatSource, context, { filename: COMPAT_SCRIPT });
  assert.equal(attributes['biliplus-content-script'], '1');
  // 兼容层本体确实没有生效（这正是探针要能穿透的情况）。
  assert.equal(context.__biliplusExtApiCompat, undefined);
});

test('内容脚本注入探针：正常情况写入 biliplus-content-script', () => {
  const env = createFirefoxEnv();
  const attributes = {};
  const elementStub = {
    getAttribute: name => (name in attributes ? attributes[name] : null),
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
  };
  const context = vm.createContext({
    chrome: env.chrome,
    browser: env.browser,
    console,
    document: {
      documentElement: elementStub,
      addEventListener: () => {
        throw new Error('不应注册兜底监听');
      },
    },
  });
  vm.runInContext(compatSource, context, { filename: COMPAT_SCRIPT });
  assert.equal(attributes['biliplus-content-script'], '1');
});

test('内容脚本注入探针：document_start 阶段没有 <html> 时靠兜底补写', () => {
  const env = createFirefoxEnv();
  const attributes = {};
  const listeners = {};
  const documentStub = {
    documentElement: null,
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
  };
  const context = vm.createContext({
    chrome: env.chrome,
    browser: env.browser,
    console,
    document: documentStub,
  });
  vm.runInContext(compatSource, context, { filename: COMPAT_SCRIPT });

  // 此刻 <html> 还没建立，属性写不上，但兜底必须已注册。
  assert.deepEqual(attributes, {});
  assert.equal(typeof listeners.DOMContentLoaded, 'function');
  assert.equal(typeof listeners.readystatechange, 'function');

  // <html> 出现后，任意一个时机触发都应该写上；重复触发不会出错。
  documentStub.documentElement = {
    getAttribute: name => (name in attributes ? attributes[name] : null),
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
  };
  listeners.readystatechange();
  assert.equal(attributes['biliplus-content-script'], '1');
  listeners.DOMContentLoaded();
  assert.equal(attributes['biliplus-content-script'], '1');
});

test('兼容层在 Chrome 环境下完全不改动 chrome.*', () => {
  const env = createFirefoxEnv();
  const context = vm.createContext({ chrome: env.chrome, console });
  const originalGet = env.chrome.storage.sync.get;
  vm.runInContext(compatSource, context, { filename: COMPAT_SCRIPT });

  assert.equal(env.chrome.storage.sync.get, originalGet);
  assert.equal(context.__biliplusExtApiCompat, undefined);
});

test('火狐发布工作流保持 ff-v* 触发与关键步骤', () => {
  const workflowPath = path.join(ROOT, '.github', 'workflows', 'firefox-release.yml');
  assert.equal(fs.existsSync(workflowPath), true, '缺少火狐发布工作流');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  // 只在自己的 ff-v* 标签上触发：上游 release-please 用的是 v*，同名标签会冲突；
  // 同时与 release.yml（Chrome 发布）保持分离。
  assert.match(workflow, /tags:\s*\n\s*-\s*'ff-v\*'/, '触发器应为 ff-v* 标签');
  assert.match(workflow, /workflow_dispatch:/, '应支持手动触发');
  assert.match(workflow, /contents:\s*write/, '需要 contents: write 才能创建 Release');

  // 关键步骤：先跑移植测试，再打包，最后上传产物
  assert.match(workflow, /node tests\/firefox-port\.test\.js/);
  assert.match(workflow, /node tools\/build-firefox\.cjs/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /dist\/\*\.xpi/);
  assert.match(workflow, /dist\/\*\.zip/);
  // 签名产物要上传，且改成可分辨的名字（未签名 vs 已签名）
  assert.match(workflow, /dist\/signed\/\*/);
  assert.match(workflow, /biliplus-firefox-\$\{RELEASE_VERSION\}-signed\.xpi/);

  // 签名必须有条件：没配 AMO 密钥的仓库不能因此失败
  assert.match(
    workflow,
    /if:\s*\$\{\{\s*env\.AMO_JWT_ISSUER/,
    'AMO 签名步骤应以密钥是否配置为条件'
  );
  // 上传 Release 用的是内置 token，不需要额外 secrets
  assert.match(workflow, /github\.token/);
});

test('兼容层覆盖源码中用到的全部 chrome.* 命名空间', () => {
  const env = createFirefoxEnv();
  const context = runCompat(env);
  const coveredNamespaces = context.__biliplusExtApiCompat.namespacePaths;

  const uncovered = [];
  for (const file of shippedScriptFiles()) {
    const source = stripCommentLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const call of collectChromeApiCalls(source, file)) {
      // 只审计方法调用：属性读取（能力检测）与事件注册在火狐上语义一致，
      // 不需要兼容层介入。
      if (!call.isCall) continue;
      const method = call.chain[call.chain.length - 1];
      if (EVENT_METHODS.has(method)) continue;
      const namespace = call.chain.slice(0, -1).join('.');
      const covered = coveredNamespaces.some(
        candidate => namespace === candidate || namespace.startsWith(`${candidate}.`)
      );
      if (!covered) uncovered.push(`${file}: chrome.${call.chain.join('.')}`);
    }
  }

  assert.deepEqual(uncovered, [], `以下调用未被兼容层覆盖：\n${uncovered.join('\n')}`);
});

test('Window 方法不丢 receiver（火狐 WebIDL 校验）', () => {
  const violations = [];
  for (const file of shippedScriptFiles()) {
    const source = stripCommentLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const violation of findReceiverViolations(source)) {
      violations.push(`${file}: ${violation}`);
    }
  }
  assert.deepEqual(violations, [], `发现火狐上会抛错的调用：\n${violations.join('\n')}`);
});

test('主机权限覆盖判定：火狐一条宽条目覆盖 Chrome 的多条窄条目', () => {
  assert.equal(matchPatternSubsumes('*://*.bilibili.com/*', '*://api.bilibili.com/*'), true);
  assert.equal(matchPatternSubsumes('*://*.bilibili.com/*', 'https://space.bilibili.com/*'), true);
  assert.equal(
    matchPatternSubsumes('*://*.bilibili.com/*', '*://*.bilibili.com/x/player/wbi/v2'),
    true
  );
  // 只支持 https 的条目覆盖不了 http+https 的条目。
  assert.equal(matchPatternSubsumes('https://*.bilibili.com/*', '*://api.bilibili.com/*'), false);
  // 不同域名互不覆盖。
  assert.equal(matchPatternSubsumes('*://*.bilibili.com/*', 'https://www.biliplus.com/*'), false);

  // 冗余检测：子域名条目被通配条目覆盖。
  assert.deepEqual(
    findRedundantHostPermissions(['*://*.bilibili.com/*', '*://api.bilibili.com/*']),
    ['*://api.bilibili.com/*']
  );
  assert.deepEqual(findRedundantHostPermissions(['*://*.bilibili.com/*']), []);

  // 火狐清单必须覆盖住 Chrome 清单里的每一条主机权限。
  assert.deepEqual(
    findUncoveredHostPermissions(
      chromeManifest.host_permissions,
      firefoxManifest.host_permissions
    ),
    []
  );
  // 冗余条目应当已经清掉（火狐会把每一条都渲染成一个授权开关）。
  assert.deepEqual(findRedundantHostPermissions(firefoxManifest.host_permissions), []);
  assert.equal(firefoxManifest.host_permissions.includes('*://api.bilibili.com/*'), false);
});

test('receiver 规则确实能抓住历史上踩过的写法', () => {
  // 火狐真机上实际报错的那段代码（把方法取出后再调用）。
  const detached = [
    'const schedule = globalScope.requestAnimationFrame || (callback => setTimeout(callback, 0));',
    'schedule(refreshDom);',
  ].join('\n');
  assert.equal(findReceiverViolations(detached).length, 1);

  // 裸调用（receiver 是沙箱全局，不是 Window）。
  assert.equal(findReceiverViolations('requestAnimationFrame(() => {});').length, 1);

  // 正确写法与能力检测不应被误报。
  const good = [
    'if (typeof window.requestAnimationFrame === "function") {',
    '  window.requestAnimationFrame(() => {});',
    '}',
    'if (!window.matchMedia) return;',
  ].join('\n');
  assert.deepEqual(findReceiverViolations(good), []);
});

test('火狐后台为事件页而非 Service Worker', () => {
  assert.equal(firefoxManifest.background.service_worker, undefined);
  assert.equal(firefoxManifest.background.type, undefined);
  const entry = fs.readFileSync(
    path.join(ROOT, 'scripts/background/firefox-background.js'),
    'utf8'
  );
  // 事件页没有 importScripts，也不应再依赖 Chrome 专有的 initiator 字段。
  assert.doesNotMatch(entry, /importScripts\(/);
  assert.match(entry, /originUrl/);
  assert.match(entry, /BiliPlusInformationCocoon/);
  assert.match(entry, /BiliPlusArchiveProxy/);

  // 后台靠这两个全局标记判断子模块是否加载成功，移植时给 archive-proxy
  // 补了导出；上游改写这个文件时这里会失败，提醒重新补上。
  const cocoon = fs.readFileSync(
    path.join(ROOT, 'scripts/background/information-cocoon.js'),
    'utf8'
  );
  assert.match(cocoon, /globalScope\.BiliPlusInformationCocoon = api/);
  const archiveProxy = fs.readFileSync(
    path.join(ROOT, 'scripts/background/archive-proxy.js'),
    'utf8'
  );
  assert.match(archiveProxy, /globalScope\.BiliPlusArchiveProxy = api/);
  assert.match(archiveProxy, /module\.exports = api/);
});

test('打包产物包含清单引用的全部文件且清单在根部', () => {
  const tempRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'biliplus-ff-'));
  const result = buildFirefoxPackage({ root: ROOT, outDir: tempRoot });

  try {
    const packagedManifest = readJson(path.join(result.unpackedDir, 'manifest.json'));
    assert.equal(
      packagedManifest.browser_specific_settings.gecko.id,
      firefoxManifest.browser_specific_settings.gecko.id
    );
    assert.deepEqual(packagedManifest.background.scripts, firefoxManifest.background.scripts);
    // 版本号必须跟着 manifest.json 走，而不是火狐清单里那份。
    assert.equal(packagedManifest.version, chromeManifest.version);
    assert.equal(fs.existsSync(path.join(result.unpackedDir, FIREFOX_MANIFEST)), false);

    const referenced = new Set([
      packagedManifest.action.default_popup,
      packagedManifest.options_ui.page,
      ...Object.values(packagedManifest.icons),
      ...Object.values(packagedManifest.action.default_icon),
      ...packagedManifest.background.scripts,
      ...packagedManifest.content_scripts.flatMap(entry => [...entry.js, ...(entry.css || [])]),
    ]);
    for (const file of referenced) {
      assert.equal(
        fs.existsSync(path.join(result.unpackedDir, file)),
        true,
        `打包后缺少 ${file}`
      );
    }
    // Chrome 专用后台入口与仓库截图不应混进火狐包。
    assert.equal(result.files.includes('scripts/background/service-worker.js'), false);
    assert.equal(result.files.some(file => file.startsWith('img/screenshot')), false);
    assert.equal(result.files.some(file => file.endsWith('.DS_Store')), false);
    assert.equal(result.archives.length, 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/** 最小 ZIP 读取器：独立校验自家写出的压缩包结构。 */
function readZip(buffer) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buffer.lastIndexOf(endSignature);
  assert.notEqual(end, -1, 'ZIP 缺少中央目录结束记录');
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, '中央目录签名错误');
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, '本地文件头签名错误');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(content.length, uncompressedSize, `${name} 解压长度不符`);

    entries.push({ name, content, crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('自研 ZIP 写入器产出的火狐压缩包可被独立解析', () => {
  const files = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}', 'utf8') },
    { name: 'scripts/测试.js', data: Buffer.from('const 中文 = 1;\n'.repeat(200), 'utf8') },
  ];
  const entries = readZip(createZip(files));
  assert.deepEqual(entries.map(entry => entry.name), ['manifest.json', 'scripts/测试.js']);
  assert.equal(entries[0].content.toString('utf8'), '{"a":1}');
  assert.equal(entries[1].content.toString('utf8'), files[1].data.toString('utf8'));
});
