/**
 * BiliPlus 火狐（Firefox）兼容层：让 chrome.* 命名空间重新支持 Promise。
 *
 * 背景
 * ----
 * Chrome 的 MV3 里，chrome.* 异步 API 在不传回调时返回 Promise，因此本项目大量
 * 使用 `await chrome.storage.sync.get(...)` / `chrome.storage.sync.get(...).then(...)`。
 *
 * Firefox 把 chrome.* 当作「Chrome 兼容模式」：即使调用方没有传回调，Firefox 内部
 * 也会补一个空回调（见 Firefox 源码 modules/Schemas.sys.mjs 中 isChromeCompat 分支），
 * 于是这些调用永远返回 undefined。在火狐上 `await chrome.storage.sync.get()` 得到
 * undefined，直接取属性或 .then 就会抛错，相关功能整体失效。
 *
 * 处理方式
 * --------
 * 1. 未传回调的调用改走 Firefox 原生 browser.*（原生返回真正的 Promise，错误以
 *    Promise reject 形式抛出）；
 * 2. 传了回调的调用保持原样走 chrome.*，因此 runtime.lastError、sendResponse 等
 *    Chrome 风格语义完全不变。
 *
 * 在 Chrome 上不存在 browser 命名空间，本文件会立即返回，不做任何改动，
 * 所以同一份源码可以同时用于 Chrome 与 Firefox。
 */
(function installExtApiCompat(globalScope) {
  'use strict';

  // 注入探针：内容脚本到底有没有被注入，从页面控制台一句话就能确认——
  //   document.documentElement.getAttribute('biliplus-content-script')
  // 它必须放在本文件最前面，且不受下面任何提前返回影响：否则一旦某个
  // 判断提前 return，探针就会给出误导性的 null（"看起来没注入"）。
  const PROBE_ATTRIBUTE = 'biliplus-content-script';

  const markContentScriptLoaded = () => {
    const root = globalScope.document?.documentElement;
    if (!root) return false;
    if (root.getAttribute(PROBE_ATTRIBUTE) !== '1') {
      root.setAttribute(PROBE_ATTRIBUTE, '1');
    }
    return true;
  };

  try {
    if (!markContentScriptLoaded()) {
      // document_start 阶段 <html> 可能还没建立，多留几个时机兜底；
      // 函数是幂等的，哪个先来都能写上。定时重试上限约 2 秒。
      const doc = globalScope.document;
      doc?.addEventListener('readystatechange', markContentScriptLoaded);
      doc?.addEventListener('DOMContentLoaded', markContentScriptLoaded, { once: true });
      let attempts = 0;
      const retryProbe = () => {
        attempts += 1;
        if (markContentScriptLoaded() || attempts >= 10) return;
        globalScope.setTimeout?.(retryProbe, attempts * 50);
      };
      globalScope.setTimeout?.(retryProbe, 0);
    }
  } catch (_error) {
    // 没有文档环境（例如后台事件页）时忽略。
  }

  const MARK = '__biliplusExtApiCompat';

  // 只在 Firefox 中生效：Firefox 才有 browser 命名空间与 getBrowserInfo。
  const nativeBrowser = globalScope.browser;
  if (
    !nativeBrowser ||
    typeof nativeBrowser.runtime?.getBrowserInfo !== 'function'
  ) {
    return;
  }

  const chromeApi = globalScope.chrome;
  if (!chromeApi) return;
  if (globalScope[MARK]) return;

  /** 需要 Promise 化的命名空间路径（只覆盖扩展实际使用到的部分）。 */
  const NAMESPACE_PATHS = Object.freeze([
    ['storage', 'sync'],
    ['storage', 'local'],
    ['storage', 'session'],
    ['runtime'],
    ['tabs'],
    ['permissions'],
    ['declarativeNetRequest'],
    ['scripting'],
    ['action'],
  ]);

  const SKIP_KEYS = new Set(['length', 'name', 'prototype', 'constructor']);

  const resolveNamespace = (root, path) => {
    let node = root;
    for (const key of path) {
      node = node?.[key];
      if (!node) return null;
    }
    return node;
  };

  const applied = [];
  const failed = [];

  const makePromiseCapable = (label, chromeFn, browserFn) => {
    const wrapped = function (...args) {
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'function') {
        // 回调风格：沿用 chrome.* 的 Chrome 兼容语义（含 runtime.lastError）。
        return chromeFn.apply(this, args);
      }
      // Promise 风格：使用 Firefox 原生 browser.*，返回真正的 Promise。
      const result = browserFn.apply(this, args);
      return result;
    };
    try {
      Object.defineProperty(wrapped, 'name', { value: label, configurable: true });
    } catch (_error) {
      // 函数名只是调试信息，改不了也不影响功能。
    }
    return wrapped;
  };

  for (const path of NAMESPACE_PATHS) {
    const chromeNamespace = resolveNamespace(chromeApi, path);
    const browserNamespace = resolveNamespace(nativeBrowser, path);
    if (!chromeNamespace || !browserNamespace) continue;

    for (const key of Object.getOwnPropertyNames(chromeNamespace)) {
      if (SKIP_KEYS.has(key)) continue;

      let chromeMember;
      try {
        chromeMember = chromeNamespace[key];
      } catch (_error) {
        continue;
      }
      if (typeof chromeMember !== 'function') continue;

      let browserMember;
      try {
        browserMember = browserNamespace[key];
      } catch (_error) {
        browserMember = null;
      }
      // browser 侧没有同名实现时保持 chrome 原样，避免把可用的 API 改坏。
      if (typeof browserMember !== 'function') continue;

      const label = `${path.join('.')}.${key}`;
      try {
        Object.defineProperty(chromeNamespace, key, {
          value: makePromiseCapable(label, chromeMember, browserMember),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      } catch (error) {
        failed.push(`${label}: ${error?.message || error}`);
        continue;
      }

      if (chromeNamespace[key] === chromeMember) {
        failed.push(`${label}: 属性只读，未能改写`);
      } else {
        applied.push(label);
      }
    }
  }

  const report = {
    engine: 'firefox',
    namespacePaths: NAMESPACE_PATHS.map(path => path.join('.')),
    applied,
    failed,
  };

  try {
    Object.defineProperty(globalScope, MARK, {
      value: report,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch (_error) {
    globalScope[MARK] = report;
  }

  if (failed.length > 0) {
    // 出现这种情况说明 Firefox 的 API 注入方式变了，功能可能会失效，
    // 明确报错以便定位，而不是静默降级。
    console.error(
      '[BiliPlus] 火狐兼容层未能改写以下 API，相关功能可能异常：',
      failed
    );
  }
})(typeof globalThis === 'undefined' ? this : globalThis);
