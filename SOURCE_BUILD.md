# Source build instructions (for Mozilla add-on reviewers)

This repository is a Firefox port of the MIT-licensed project
[0xlau/biliplus](https://github.com/0xlau/biliplus). The submitted XPI is built
from this source with a single command. **No bundler, transpiler or minifier is
involved**: every JavaScript, CSS and HTML file inside the package is copied
verbatim from this repository.

## Requirements

- **Node.js 20 or newer** (developed and verified with Node.js 22 and 24).
  The build and test scripts use only Node built-in modules, therefore
  **there is no `npm install` step** and no third-party dependencies.
- Any operating system. The build is plain Node.js; it was developed on Windows
  and also runs on Linux and macOS.
- `git` is only needed to obtain the sources. No compilers, SDKs or browsers are
  required to build.

## Build

```sh
node tools/build-firefox.cjs
```

The script (`tools/build-firefox.cjs`, logic in `tools/firefox-package.cjs`)
performs the following steps, all of them deterministic:

1. Validates `manifest.firefox.json`: required Firefox fields, referenced files,
   permission names, and parity with the Chrome `manifest.json`.
2. Copies the extension files (`css/`, `scripts/`, `settings/`, `img/`,
   `logo.png`, `LICENSE`) into `dist/firefox/`, skipping development-only assets
   (upstream screenshots in `img/`, and the Chrome-only background service
   worker `scripts/background/service-worker.js`).
3. Writes `dist/firefox/manifest.json`: it is `manifest.firefox.json` with the
   `version` field synced from `manifest.json` (single source of truth for the
   version number). This manifest is the only generated file in the package.
4. Packs `dist/firefox/` into `dist/biliplus-firefox-<version>.zip` and
   `dist/biliplus-firefox-<version>.xpi` with a small ZIP writer built on Node's
   `zlib` (no external zip tool is called).

Outputs:

- `dist/firefox/` — the unpacked extension (loadable through `about:debugging`)
- `dist/biliplus-firefox-<version>.xpi` — the file submitted to AMO

## Verify

```sh
node tests/firefox-port.test.js
```

This runs the port's invariant tests: manifest structure and Chrome/Firefox
parity, the `chrome.*` compatibility layer, the content-script injection probe,
the host-permission rules, the webRequest receiver rules, and the integrity of
the generated ZIP.

## Third-party code

- `scripts/common/md5.min.js` — a **vendored, minified** build of
  [js-md5](https://github.com/emn178/js-md5) v0.8.0 (MIT, © Chen, Yi-Cyuan).
  It is distributed as part of the upstream repository and is the only minified
  file in the package; its unminified sources are available at the link above.
- `img/icon-16.png`, `img/icon-32.png`, `img/icon-48.png`, `img/icon-96.png` —
  resized versions of the repository's `logo.png` (128 px). `logo.png` itself is
  used unchanged.

All remaining files are original project source.

## Differences from the upstream Chrome build

Firefox's Manifest V3 differs from Chrome's, so the port adds:

- `manifest.firefox.json` — Firefox manifest (background event page via
  `background.scripts` instead of a service worker; host permissions).
- `scripts/common/ext-api-compat.js` — makes `chrome.*` promise-capable on
  Firefox, where `chrome.*` calls never return promises.
- `scripts/background/firefox-background.js` — event-page background entry.

The Chrome variant is untouched (`manifest.json`, `make zip`). See
`docs/firefox.md` for a full description of the differences.
