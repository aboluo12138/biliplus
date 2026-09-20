# 火狐（Firefox）扩展打包说明

本仓库原本是面向 Chrome / Edge 的 MV3 扩展。这个目录下的改动让它同时能打包成**火狐扩展**，
并且**不影响原来的 Chrome 版本**（`manifest.json`、`make zip` 全部保持原样）。

## 快速开始

```sh
# 生成火狐扩展包（校验 + 组装 + 压缩）
node tools/build-firefox.cjs

# 或者
make firefox          # Linux / macOS
make-firefox.bat      # Windows
```

产物：

| 路径 | 用途 |
| --- | --- |
| `dist/firefox/` | 未打包目录，火狐里临时加载用这个 |
| `dist/biliplus-firefox-<版本>.zip` | 上传 AMO 审核、或临时加载 |
| `dist/biliplus-firefox-<版本>.xpi` | 与 zip 内容相同，方便直接分发 |

### 在火狐里临时加载（开发调试）

1. 打开 `about:debugging#/runtime/this-firefox`；
2. 点击「临时载入附加组件…」；
3. 选择 `dist/firefox/manifest.json`（也可以直接选 zip / xpi 文件）。

临时加载的扩展在火狐重启后失效，这是火狐自身的限制。

### 永久安装 / 上架 AMO

火狐正式版（Release）**只允许安装经过签名的扩展**，未签名的 xpi 无法永久安装。
要永久安装或上架，需要用 AMO 账号签名：

```sh
npx web-ext sign --source-dir dist/firefox --channel unlisted \
  --api-key <AMO_JWT_ISSUER> --api-secret <AMO_JWT_SECRET>
```

或者直接把 `dist/biliplus-firefox-<版本>.zip` 上传到
[AMO 开发者中心](https://addons.mozilla.org/developers/)：

- 如果这是**新扩展**：新建附加组件，上传 zip。
- 如果要**更新已有的 AMO 列表**：必须把 `manifest.firefox.json` 里的
  `browser_specific_settings.gecko.id` 改成该列表正在使用的 ID，否则会被当成另一个扩展。
  当前填的是占位值 `biliplus@0xlau.dev`。

> 提交 AMO 时可能还需要按 AMO 的最新要求声明数据收集用途（`data_collection_permissions`）。
> 这一点和 Chrome 上架流程类似，按 AMO 后台提示填写即可。

### 用 GitHub Actions 自动打包（可选）

仓库里带了 `.github/workflows/firefox-release.yml`，**只在自己的 `ff-v*` 标签上触发**——
刻意不用 `v*`，避免和上游 release-please 的标签撞名，也和 `release.yml`（Chrome 发布）完全分开。

流程：校验标签与 `manifest.json` 版本一致 → 跑移植测试 → 构建 → 上传
`dist/*.xpi`、`dist/*.zip` 到对应的 GitHub Release。

```sh
# 例如当前是 1.2.0
git tag ff-v1.2.0
git push origin ff-v1.2.0
```

也可以在仓库的 Actions 页面手动触发（`workflow_dispatch`），填标签名即可。

**顺带签名**：如果在仓库 Secrets 里配置了 `AMO_JWT_ISSUER` 和 `AMO_JWT_SECRET`
（AMO 后台生成），工作流会额外用 `web-ext sign --channel unlisted` 签出一个可永久安装的
xpi 并一并上传；没配置这两个密钥就跳过签名，只上传未签名包。

> 注意：fork 里默认不启用 Actions。如果你在 fork 里打开了 Actions，
> 上游自带的 `release.yml` 会在 push 到 main 时运行（建 Release PR / 发 Chrome 应用商店），
> 那需要上游的密钥，通常只会失败报错——不想看到的话就别启用它。

## 跟进上游更新（原作者发新版后）

移植层分两类，跟进成本完全不同：

- **纯新增文件**：不会和上游冲突，拷贝过去即可
- **对上游文件的小改动**：一共 9 处（见本节末尾），上游改了这些文件时需要重新应用

关键是**不靠记忆**：`node tools/build-firefox.cjs` 会校验火狐清单与 Chrome 清单的功能对等，
`node tests/firefox-port.test.js` 会校验全部移植不变量——**漏了什么都会指名报错**。

### 流程（本机没装 Git 也能做）

```sh
# 1. 下载上游新版压缩包并解压，例如得到 biliplus-upstream/
# 2. 把移植层文件从旧目录拷进新目录：
#      manifest.firefox.json
#      scripts/common/ext-api-compat.js
#      scripts/background/firefox-background.js
#      tools/firefox-package.cjs  tools/build-firefox.cjs
#      tests/firefox-port.test.js
#      docs/firefox.md
#      make-firefox.bat
#      img/icon-16.png  img/icon-32.png  img/icon-48.png  img/icon-96.png
# 3. 按下面表格重新应用对上游文件的 9 处小改动
# 4. 校验并重新打包（有错漏会直接报出来）
cd biliplus-upstream
node tools/build-firefox.cjs
node tests/firefox-port.test.js
```

### 用 Git（推荐，长期更省事）

仓库已经初始化好了：`biliplus-main/` 下有 `.git`，基线提交为「Firefox 移植基线」，
`dist/`（打包产物）已加入 `.gitignore`。

提交身份当前是占位值，推到 GitHub 之前先改成你自己的：

```sh
cd biliplus-main
git config user.name "你的名字"
git config user.email "你的邮箱"
git commit --amend --reset-author --no-edit   # 只改了这一个提交的署名
```

**第一次接上上游**（需要联网，在能访问 GitHub 的机器上执行）：

```sh
git remote add upstream https://github.com/0xlau/biliplus.git
git fetch upstream
# 关键一步：新 init 的仓库与上游没有共同祖先，直接 merge 会报
# "refusing to merge unrelated histories"。必须先把分支指针落到上游历史上，
# 工作区文件不受影响，然后把移植作为一次提交接上去。
git reset --mixed upstream/main
git add -A
git commit -m "feat: Firefox 移植"
```

做完这一步，你的移植就挂在真正的上游历史之上了。

**之后每次跟进上游：**

```sh
git fetch upstream
git merge upstream/main        # 冲突只会出现在下面那 9 个文件里
node tools/build-firefox.cjs   # 重新校验 + 打包（错漏会直接报出来）
node tests/firefox-port.test.js
```

> 本机环境访问不了 GitHub（TLS 凭证错误），所以「第一次接上上游」这一步需要你在
> 能联网的环境里执行。

### 上游改了什么 → 你需要做什么

| 上游改动 | 漏了会报什么 | 要改的地方 |
| --- | --- | --- |
| 版本号 | 不报错（**打包时自动从 `manifest.json` 同步**） | 不用管 |
| `manifest.json` 加权限 | `火狐清单缺少 Chrome 清单中的权限：xxx` | `manifest.firefox.json` → `permissions` |
| 新增内容脚本 / matches / CSS | `Chrome 清单注入了 xxx，火狐清单缺少对应注入` | `manifest.firefox.json` → `content_scripts`（新条目的 `js` 第一项必须是 `scripts/common/ext-api-compat.js`） |
| 新增后台脚本 | `background.scripts 缺少 xxx` | `manifest.firefox.json`（`firefox-background.js` 保持最后） |
| 新增扩展页面 | `xxx 未引入火狐兼容层` | 该页面 `<script>` 之前加 `<script src="../scripts/common/ext-api-compat.js" defer></script>` |
| 用到新的 `chrome.xxx` 命名空间 | `chrome.xxx.yyy 未被兼容层覆盖` | `ext-api-compat.js` 的 `NAMESPACE_PATHS` |
| 又写成裸调用 `requestAnimationFrame(...)` | `裸调用 xxx()，必须写成 window.xxx(...)` | 改成成员调用 |
| 改动 `scripts/background/archive-proxy.js` | `后台靠全局标记判断子模块是否加载` | 保留 `globalScope.BiliPlusArchiveProxy = api` 和 `module.exports = api` |
| 更换 `logo.png` | 不报错 | 顺带重新缩放生成 `img/icon-*.png`（否则图标还是旧的） |

### 移植改过的 9 个上游文件（merge 冲突只会在这里）

1. `scripts/hide-hot-search-list.js` —— `requestAnimationFrame` 保留 receiver
2. `scripts/clean-home-page.js` —— 同上
3. `scripts/invalid-video-info.js` —— `window.getComputedStyle(box)`（2 处）
4. `scripts/background/archive-proxy.js` —— 导出 `BiliPlusArchiveProxy`、`module.exports = api`
5. `settings/popup.html` —— 引入兼容层
6. `settings/settings.html` —— 引入兼容层 + 站点授权提示条
7. `settings/settings-hide-user-comment.html` —— 引入兼容层
8. `settings/js/settings.js` —— 站点授权逻辑（仅火狐显示）
9. `settings/css/settings.css` —— 授权提示条样式

`makefile`（加了 `firefox` 目标）与 `README*.md`（加了火狐说明）只是追加内容，
冲突时取并集即可。

## 火狐与 Chrome 的差异（以及本移植怎么处理的）

火狐的 MV3 和 Chrome 的 MV3 并不完全相同，主要包括四处，都已处理：

### 1. 后台不能用 Service Worker，只能用事件页

Chrome 版是 `background.service_worker` + `importScripts`；火狐的后台以事件页
（`background.scripts`）为准，事件页是普通文档上下文，没有 `importScripts`。

处理方式：火狐清单改用 `background.scripts`，按顺序加载
`ext-api-compat.js` → `information-cocoon.js` → `archive-proxy.js` → `firefox-background.js`。
每个文件是独立的 `<script>`，单个文件出错不会影响其它文件，效果等同于原来
`importScripts` 的 try/catch 隔离。`scripts/background/firefox-background.js`
承接了原 `service-worker.js` 里的字幕探测逻辑。

### 2. `chrome.*` 在火狐上不返回 Promise

Chrome 的 MV3 里，`chrome.storage.sync.get(...)` 不传回调时返回 Promise，
所以项目里大量使用 `await chrome.storage.sync.get(...)`。

火狐把 `chrome.*` 当作「Chrome 兼容模式」：即使不传回调，内部也会补一个空回调，
异步调用**永远返回 undefined**（见火狐源码 `modules/Schemas.sys.mjs` 的
`isChromeCompat` 分支）。于是 `await chrome.storage.sync.get()` 得到 `undefined`，
一取属性或调 `.then` 就会抛错。

处理方式：新增 `scripts/common/ext-api-compat.js`：

- 不传回调的调用 → 改走火狐原生 `browser.*`（真正返回 Promise）；
- 传了回调的调用 → 保持原来的 `chrome.*` 行为（`runtime.lastError`、
  `sendResponse` 等 Chrome 语义完全不变）。

该文件在 Chrome 上检测不到 `browser` 命名空间会立即返回，不做任何改动，
所以同一份源码两边都能跑。它会被注入到：每个内容脚本的最前面、后台脚本的第一个、
以及三个扩展页面（`popup.html` / `settings.html` / `settings-hide-user-comment.html`）。

### 3. `webRequest` 详情字段不同

Chrome 提供 `details.initiator`，火狐提供的是 `details.originUrl`（`documentUrl` 兜底）。
`firefox-background.js` 已按火狐字段判断请求来源，判断扩展自身请求时同时匹配
`moz-extension://` 与 `chrome-extension://`。

### 4. 火狐 MV3 的主机权限是「按站点授权」的

这是**使用者最容易困惑的一点**：火狐从 127 版本起对 MV3 扩展采用站点授权
（origin controls）模型——清单里的 `host_permissions` 在安装时**不会自动授予**。
在用户授权之前：

- 内容脚本不会注入 B 站页面（扩展看起来"没反应"）；
- `webRequest` / `declarativeNetRequest` 规则也不会对 B 站生效。

因此火狐清单把 `*://*.bilibili.com/*` 加进了 `host_permissions`（Chrome 清单原本只列了
API 端点），这样火狐才会把「访问 B 站」作为可授予的权限呈现出来。

**安装后需要用户做的事**：

1. 打开扩展的**完整设置页**（弹窗底部「打开完整设置」），如果顶部出现黄色提示条，
   点「**允许访问 B 站**」——这是最省事的路径，走 `permissions.request`，火狐会弹授权框；
2. 也可以自己在 `about:addons` → BiliPlus → 「权限」标签页里，把 B 站相关开关打开；
3. 授权后**刷新** B 站页面（新开标签页最稳妥）。

> 注意：**重新载入/重装扩展可能重置站点授权**，所以先装好扩展、最后再授权。

**装好之后页面还是没变化？** 先看探针（见下），再确认功能开关：

```js
// 在 B 站页面的控制台执行
document.documentElement.getAttribute('biliplus-content-script')
```

`"1"` 表示内容脚本已注入（兼容层写的标记，与功能开关无关），`null` 表示没注入
（多半是站点授权没生效，或页面是在授权前加载的，刷新即可）。

另外提醒：**扩展不会默认开启任何功能**。总开关和每个具体功能都默认关闭
（`settings/js/settings.js` 里 `storage[key] ?? SETTINGS_DEFAULTS[key] ?? false`），
需要先在弹窗打开总开关，再在设置页逐个开启。

#### 为什么权限列表里会出现好几项 bilibili.com（是否重叠？）

在 `about:addons` → 「权限」里会看到多行 B 站相关条目，它们**来源不同**：

| 显示条目 | 来源 | 能否删 |
| --- | --- | --- |
| `*://bilibili.com` | `host_permissions` 的 `*://*.bilibili.com/*` | 不能：`webRequest`、`declarativeNetRequest` 规则需要 |
| `https://bilibili.com` | 内容脚本 `matches: https://*.bilibili.com/*` | 不能：决定脚本注入范围 |
| `https://www.bilibili.com` | 内容脚本 `matches: https://www.bilibili.com/*` 等 | 不能：同上（这几个入口比上一条窄，是有意为之） |
| `https://space.bilibili.com` | 内容脚本 `matches: https://space.bilibili.com/*` | 不能：同上 |

关键点：**火狐会把内容脚本的匹配规则也列为可授权项**（origin controls），
所以看起来像 host 权限重复了，其实大部分来自 `content_scripts.matches`，用于控制
"哪个脚本注入哪些页面"，合并会改变行为。

其中真正冗余的只有 `*://api.bilibili.com/*`（已被 `*://*.bilibili.com/*` 完全覆盖），
已经删除；`tools/firefox-package.cjs` 现在会拒绝任何被同组内更宽条目覆盖的权限条目，
避免这类噪音重新出现。

**实际怎么授权**：先开最宽的那条 `*://bilibili.com`（涵盖 api / www / space）就够了；
若某个页面仍未生效，再把对应的窄条目也打开。只有用到「失效视频信息」时，
才需要开 `biliplus.com` / `jijidown.com` 这两条可选来源。

### 5. Window 方法不能丢 receiver（真机实测发现）

火狐对 `Window` 上的部分方法做 WebIDL receiver 校验，只有
`obj.method(...)` 这种当场带 receiver 的调用才合法。以下两种写法在 Chrome 上能跑，
在火狐上会抛 `TypeError: 'xxx' called on an object that does not implement interface Window`：

```js
// 1) 把方法取出来再调用（丢 receiver）
const schedule = window.requestAnimationFrame;
schedule(callback);

// 2) 裸调用（receiver 是内容脚本沙箱的全局对象，不是 Window）
requestAnimationFrame(callback);
```

正确写法是保持成员调用形式：`window.requestAnimationFrame(callback)`。

这是移植后在真机火狐上实测暴露的问题，已修的三处：

| 位置 | 原写法 | 现写法 |
| --- | --- | --- |
| `scripts/hide-hot-search-list.js` | `const schedule = ...requestAnimationFrame; schedule(cb)` | `globalScope.requestAnimationFrame(cb)` |
| `scripts/clean-home-page.js` | `requestAnimationFrame(() => ...)` | `window.requestAnimationFrame(() => ...)` |
| `scripts/invalid-video-info.js` | `getComputedStyle(box)` | `window.getComputedStyle(box)` |

`tests/firefox-port.test.js` 里有一条静态规则守住这个不变量：
`requestAnimationFrame` / `cancelAnimationFrame` / `getComputedStyle` / `matchMedia`
必须写成成员调用（能力检测 `typeof window.xxx` 不在此列），并且有自检用例确保这条规则
真的能抓住上面第 1、2 种写法。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `manifest.firefox.json` | 火狐专用清单（Chrome 的 `manifest.json` 未被修改） |
| `scripts/common/ext-api-compat.js` | `chrome.*` → Promise 兼容层 |
| `scripts/background/firefox-background.js` | 火狐事件页后台入口（字幕探测 + 后台模块兜底报错） |
| `tools/firefox-package.cjs` | 清单校验、打包组装、ZIP 写入（无第三方依赖） |
| `tools/build-firefox.cjs` | 命令行入口 |
| `tests/firefox-port.test.js` | 火狐移植测试（见下） |
| `img/icon-16.png` 等 | 从 `logo.png` 缩放出的火狐工具栏/列表图标 |
| `make-firefox.bat` | Windows 构建入口 |

`scripts/background/archive-proxy.js` 只做了一处小改动：额外把模块挂到
`globalThis.BiliPlusArchiveProxy`（与 `information-cocoon.js` 原有的导出方式一致），
便于火狐事件页后台判断该模块是否加载成功。

## 自动化校验

`tests/firefox-port.test.js` 覆盖这些不变量：

1. 火狐清单结构合法：版本与 `manifest.json` / `version.txt` 一致、
   有 gecko ID、没有 `service_worker`、权限都在火狐可用白名单内、
   引用到的文件都存在；
2. **与 Chrome 清单功能对等**：Chrome 注入的每个 JS / CSS / 匹配规则 / 权限，
   火狐清单都必须有——以后加功能时忘了同步火狐清单会直接测试失败；
3. 兼容层在每个执行环境中最先加载；
4. 用 mock 复现火狐「`chrome.*` 不返回 Promise」的行为，验证：
   未加载兼容层时确实返回 `undefined`，加载后 Promise 风格调用可用，
   回调风格仍走 `chrome.*` 并保留 `runtime.lastError` 语义，
   在 Chrome 环境下完全不改动 `chrome.*`；
5. **审计源码中所有 `chrome.*` 调用点**，确保用到的命名空间都被兼容层覆盖
   （以后有人写了个兼容层没覆盖的 `await chrome.xxx.yyy()`，测试会报出来）；
6. **主机权限**：火狐的 `host_permissions` 必须覆盖住 Chrome 的每一条（允许更宽，
   但不允许漏），且组内不允许存在被更宽条目覆盖的冗余项；
7. **Window 方法不丢 receiver**：`requestAnimationFrame` 等必须是成员调用，
   并有自检用例保证规则本身有效；
8. **注入探针必须有效**：探针写在兼容层最前面、先于所有提前返回
   （曾经因为写在 `return` 之后而给出误导性的 `null`），并覆盖
   `<html>` 晚建立时的兜底路径；
9. **设置页的火狐授权入口**：存在「允许访问 B 站」按钮，且只在火狐上显示
   （Chrome 安装即授权，且 Chrome 清单没有这条 origin，调 `request()` 会抛错）；
10. 打包产物完整：清单在根部、引用的文件都在、ZIP 能被独立解析器读出。

运行：

```sh
node tests/firefox-port.test.js
```

## 真机验证记录（Firefox 156 / Windows）

移植完成后在真实火狐上逐项验证过。以下都是实测结论，不是推断：

| 项目 | 验证方式 | 结果 |
| --- | --- | --- |
| 清单与后台加载 | `about:debugging` 临时加载，看后台 Console | 正常；三个后台模块都加载成功 |
| `chrome.*` Promise 兼容层 | 后台 Console 执行 `__biliplusExtApiCompat` | `applied: (89), failed: []` —— 89 个 API 全部改写成功 |
| 兼容层在**内容脚本**里同样生效 | 内容脚本的 `chrome.storage.sync.get(...).then(...)` 正常走到写属性 | 生效（这是纯静态分析无法覆盖的路径） |
| 内容脚本注入 | `<html>` 上的 `biliplus-content-script` 探针 + `body` 上的 `biliplus-*` 类 | 注入正常 |
| 具体功能 | 无缝倍速、搜索净化等 | 正常（`body` 上出现 `biliplus-stepless-video-rate`、`biliplus-hide-hot-search-list`） |
| `requestAnimationFrame` receiver 修复 | 首页 Console 不再出现 `called on an object that does not implement interface Window` | 已修复 |
| 信息茧房规则下发 | `<html>` 的 `biliplus-information-cocoon-rules` = `active` | 9 条规则下发成功 |
| 信息茧房实际效果 | 网络面板查看 `/x/web-interface/wbi/index/top/feed/rcmd` 请求头 | **没有 `Cookie`**，接口仍返回 200 + 4.04 kB |
| 规则作用范围（对照） | 同域名非目标接口 `/x/business/nav` 的请求头 | **仍带 `Cookie`** —— 规则精确生效，没有误伤其它接口 |

关于那两条诊断属性：

- `biliplus-information-cocoon-rules` 的三种取值都是**正确**状态：
  `inactive`（总开关或模式开关关闭）、`active`（规则已下发）、`error`（下发失败）。
  两个开关是 **AND** 关系，只开总开关仍是 `inactive`。
- `biliplus-information-cocoon-match` 在火狐上恒为 `unknown`：命中探测依赖
  `declarativeNetRequest.testMatchOutcome()`，而该接口在火狐 schema 里要求
  `declarativeNetRequestFeedback` 权限（属于 `OptionalPermission`），本项目未声明它，
  所以该 API 在火狐上不存在，代码的能力检测会跳过探测。Chrome 因同样的权限限制
  （仅未打包扩展可用）也是 `unknown`，**两边行为一致**。
  要看实际效果请用网络面板确认 Cookie 是否被摘除，不要依赖这个属性。

## 已知限制

- **站点授权**：见上文第 4 点，火狐上必须由用户授予 B 站访问权限，扩展无法绕过。
  设置页提供了「允许访问 B 站」按钮来简化这一步。
- **`biliplus-information-cocoon-match` 恒为 `unknown`**：见上表说明，属预期行为；
  想让它可用需要额外声明 `declarativeNetRequestFeedback` 可选权限，功能上并不需要。
- **功能默认全部关闭**：总开关与每个具体功能默认 `false`（`settings/js/settings.js`
  里 `storage[key] ?? SETTINGS_DEFAULTS[key] ?? false`），装好后需自行开启。
- **最低火狐版本**：`strict_min_version` 为 `128.0`
  （`declarativeNetRequestWithHostAccess` 与 origin controls 需要较新版本）。
- 验证覆盖的是火狐 156；更老的火狐版本未实测。

