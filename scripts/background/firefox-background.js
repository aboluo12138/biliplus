/**
 * Firefox（火狐）MV3 后台入口。
 *
 * Chrome 版使用 Service Worker：background.service_worker + importScripts。
 * Firefox MV3 目前不支持后台 Service Worker，只支持事件页（background.scripts），
 * 事件页是普通文档上下文，没有 importScripts，因此这里做等价实现：
 *
 * 1. information-cocoon.js / archive-proxy.js 由 manifest 的 background.scripts
 *    按顺序作为独立脚本加载，各自注册自己的 onMessage 监听（单个文件出错不会
 *    影响其它文件，效果等同于 Chrome 版 importScripts 的 try/catch 隔离）；
 * 2. 本文件负责原 service-worker.js 中基于 webRequest 的字幕探测逻辑；
 * 3. 若某个后台模块没能加载，则明确回复错误，避免调用方一直等待。
 */
(function initFirefoxBackground(globalScope) {
  'use strict';

  const chromeApi = globalScope.chrome;
  const runtime = chromeApi?.runtime;
  if (!runtime) return;

  /** background.scripts 中应该在本次之前加载完成的子模块。 */
  const MODULES = Object.freeze([
    {
      label: '拒绝信息茧房',
      globalName: 'BiliPlusInformationCocoon',
      messageType: 'biliplus-sync-information-cocoon',
    },
    {
      label: '失效视频归档代理',
      globalName: 'BiliPlusArchiveProxy',
      messageType: 'biliplus-archive-fetch',
    },
  ]);

  for (const module of MODULES) {
    if (!globalScope[module.globalName]) {
      console.error(
        `[BiliPlus] ${module.label}后台模块未加载，相关功能将不可用`
      );
    }
  }

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const module = MODULES.find(item => item.messageType === message?.type);
    if (!module || globalScope[module.globalName]) return undefined;
    sendResponse({ ok: false, error: `后台模块未加载：${module.label}` });
    return false;
  });

  // 字幕探测：等价于 Chrome 版 service-worker.js 中的 webRequest 逻辑。
  // Firefox 的 webRequest 详情里没有 initiator，对应字段是 originUrl，
  // documentUrl 作为兜底。
  const isExtensionRequest = details => {
    const source =
      details.originUrl || details.initiator || details.documentUrl || '';
    return (
      source.startsWith('moz-extension://') ||
      source.startsWith('chrome-extension://')
    );
  };

  chromeApi.webRequest?.onCompleted?.addListener(
    details => {
      if (isExtensionRequest(details)) return;
      if (details.type !== 'xmlhttprequest') return;
      if (typeof details.tabId !== 'number' || details.tabId < 0) return;

      fetch(details.url)
        .then(response => response.json())
        .then(data => {
          if (!(data?.data?.subtitle?.subtitles?.length > 0)) return;
          // 页面可能已经关闭或跳转，此时 sendMessage 失败属于正常情况，
          // 必须显式 catch，否则 Firefox 会输出未处理的 Promise 拒绝。
          Promise.resolve(
            chromeApi.tabs.sendMessage(details.tabId, {
              type: 'subtitle-ready',
              exists: true,
            })
          ).catch(() => undefined);
        })
        .catch(error => console.error('获取字幕数据失败:', error));
    },
    { urls: ['*://api.bilibili.com/x/player/wbi/v2*'] }
  );
})(typeof globalThis === 'undefined' ? this : globalThis);
