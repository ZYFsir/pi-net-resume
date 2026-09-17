# Maintaining this repo

Notes for whoever works on this repository (currently just me). Users do not
need anything here — see [README.md](README.md) for install and usage.

**English** | [中文](#中文)

## Layout

```
pi-net-resume/          working copy of the extension (what the tests import)
pkg/pi-net-resume/      the publishable npm package (what `npm publish` ships)
wifi-fastlink/          the Linux/NetworkManager watcher, not published to npm
tests/                  offline test suites for both halves
package.json            repo-root shim so `pi install git:...` finds the extension
publish-package.sh      release gate + publisher
```

`pi-net-resume/index.ts` and `pkg/pi-net-resume/index.ts` are **two copies of the
same file**. Edit the package copy (`pkg/...`) and run `publish-package.sh`,
whose step 1 syncs the repo copy — or edit either one and sync manually. The
tests import the **repo** copy, so an unsynced edit will pass tests against the
wrong file. This has bitten me once already.

Install the extension as a **package** (`pi install npm:pi-net-resume`), never by
copying `index.ts` into `~/.pi/agent/extensions/`. A hand-placed copy is invisible
to `pi update --extensions` and goes stale silently — when this machine was
migrated, the hand-placed copy turned out to be missing four shipped fixes,
including the one that stops a real outage from being vetoed by a stray "quota"
in the error text. `install.sh` no longer creates one, and warns if it finds a
leftover; `install.sh --from-checkout` is the explicit opt-in for testing
unreleased changes.

## Releasing

```bash
./publish-package.sh              # verify only: nothing is published
./publish-package.sh --publish    # verify, then npm publish
./publish-package.sh --publish --dry-run
```

The gate runs six checks and stops at the first failure:

1. sync the repo copy into the package
2. both test suites (must pass)
3. `package.json` sanity: `pi-package` keyword, semver, `pi.extensions`, a
   `files` whitelist, no pi core package in `dependencies`, no `REPLACE_ME`
4. a real load through **jiti** (how pi loads extensions), including that a
   config at the documented path is actually read
5. tarball contents, with a leakage check for `tests/`, `wifi-fastlink/`,
   `node_modules/` and `.pi/`
6. 5b: the repo-root shim resolves — a git install loads from the *clone root*
   and pi has no subdirectory syntax, so a broken shim means `pi install
   git:...` **succeeds while loading nothing**

Publishing to npm needs credentials (`npm login`); the script refuses to publish
without them.

## Releasing a version

```bash
# 1. bump pkg/pi-net-resume/package.json version and CHANGELOG.md
# 2. run the gate
./publish-package.sh
# 3. publish, then tag the same commit
./publish-package.sh --publish
git commit -am "Release vX.Y.Z"
git tag -a vX.Y.Z -m "..."
git push origin main vX.Y.Z
```

The tag matters: the README documents
`pi install git:github.com/ZYFsir/pi-net-resume@vX.Y.Z`, and that only works if
the tag exists.

## Verifying a release actually installs

Do this after every publish — it has already caught one silent failure:

```bash
cp ~/.pi/agent/settings.json /tmp/settings-pre.json     # so you can restore

pi install git:github.com/ZYFsir/pi-net-resume@v1.0.0   # or npm:pi-net-resume
ls ~/.pi/agent/git/github.com/ZYFsir/pi-net-resume/     # does it contain index.ts?

pi remove git:github.com/ZYFsir/pi-net-resume
diff <(python3 -c 'import json;print(json.load(open("/tmp/settings-pre.json"))["packages"])') \
     <(python3 -c 'import json;print(json.load(open("'"$HOME"'/.pi/agent/settings.json"))["packages"])')
```

An install "succeeding" only means pi wrote it into `settings.json`. Also confirm
the extension file is where `pi.extensions` points, and that loading it reads the
user's config (the `/net-resume` status line prints the config path it used).

## Housekeeping

- Never commit runtime state: `.pi/tasks/`, `.pi/settings.json`, `*.bak.*`,
  `__pycache__/`, `node_modules/`, `*.tgz`. `.gitignore` covers these; check
  `git status --short` before committing.
- `wifi-fastlink` is deliberately **not** in the npm tarball (it needs a systemd
  service and NetworkManager, which npm cannot install). Keep it that way, and
  keep its scope documented in `wifi-fastlink/README.md`.
- Both READMEs are bilingual with the English half first. Keep them in sync;
  section numbering mirrors between the halves.
- Relative links between the two README halves and across directories are easy
  to break. A quick check:

  ```bash
  python3 - <<'PY'
  import re, pathlib
  for md in pathlib.Path(".").rglob("*.md"):
      if ".git" in str(md) or "node_modules" in str(md): continue
      for link in re.findall(r"\]\((?!https?:|#)([^)]+)\)", md.read_text(encoding="utf-8")):
          t = (md.parent / link.split("#")[0]).resolve()
          if not t.exists(): print(f"{md}: {link}")
  PY
  ```

---

## 中文

这个仓库的维护笔记。使用者不需要看这里 —— 安装与用法见 [README.md](README.md)。

### 目录结构

```
pi-net-resume/          扩展的工作副本（测试实际 import 的那份）
pkg/pi-net-resume/      可发布的 npm 包（npm publish 发的是这个目录）
wifi-fastlink/          Linux/NetworkManager 看门狗，不发布到 npm
tests/                  两半的离线测试
package.json            仓库根 shim，让 pi install git:... 能找到扩展
publish-package.sh      发布门禁 + 发布脚本
```

`pi-net-resume/index.ts` 与 `pkg/pi-net-resume/index.ts` 是**同一文件的两份拷贝**。
改包副本（`pkg/...`）然后跑 `publish-package.sh`（第 1 步会同步仓库副本），
或者改任一份再手动同步。**测试 import 的是仓库副本**，所以没同步就改会导致
"测试跑的是另一个文件"。这个坑我已经踩过一次。

扩展要以**包**的形式安装（`pi install npm:pi-net-resume`），
绝不要把 `index.ts` 拷进 `~/.pi/agent/extensions/`。手放的副本对
`pi update --extensions` 不可见，会**静默过时** —— 这台机器迁移时发现手写副本
少了四个已发布的修复，其中包括"避免真断网被错误文本里的 quota 字样否决"那个。
`install.sh` 不再创建它，发现残留会警告；`install.sh --from-checkout` 是
测试未发布改动的显式开关。

### 发布

```bash
./publish-package.sh              # 只校验，不发布
./publish-package.sh --publish    # 校验后 npm publish
./publish-package.sh --publish --dry-run
```

门禁六步，遇错即停：

1. 把仓库副本同步进包目录
2. 两套测试（必须全过）
3. `package.json` 体检：`pi-package` 关键词、semver、`pi.extensions`、
   `files` 白名单、core 包不能出现在 `dependencies`、不能残留 `REPLACE_ME`
4. 用 **jiti** 真实加载（pi 的加载方式），并验证文档所述路径的配置确实被读到
5. tarball 内容 + 泄漏检查（`tests/`、`wifi-fastlink/`、`node_modules/`、`.pi/`）
6. 5b：仓库根 shim 能解析 —— git 安装是从 **clone 根**加载的，而 pi 没有子目录
   语法，shim 坏掉就意味着 `pi install git:...` **安装成功但什么都不加载**

发布到 npm 需要凭据（`npm login`），没有凭据脚本会拒绝发布。

### 发版本

```bash
# 1. 改 pkg/pi-net-resume/package.json 的 version 和 CHANGELOG.md
# 2. 跑门禁
./publish-package.sh
# 3. 发布，然后给同一个提交打 tag
./publish-package.sh --publish
git commit -am "Release vX.Y.Z"
git tag -a vX.Y.Z -m "..."
git push origin main vX.Y.Z
```

tag 很重要：README 里写的是
`pi install git:github.com/ZYFsir/pi-net-resume@vX.Y.Z`，没有 tag 就不成立。

### 验收一次发布真的能装上

每次发布后都做一遍 —— 它已经抓到过一次静默失败：

```bash
cp ~/.pi/agent/settings.json /tmp/settings-pre.json     # 便于还原

pi install git:github.com/ZYFsir/pi-net-resume@v1.0.0   # 或 npm:pi-net-resume
ls ~/.pi/agent/git/github.com/ZYFsir/pi-net-resume/     # 里面有没有 index.ts？

pi remove git:github.com/ZYFsir/pi-net-resume
diff <(python3 -c 'import json;print(json.load(open("/tmp/settings-pre.json"))["packages"])') \
     <(python3 -c 'import json;print(json.load(open("'"$HOME"'/.pi/agent/settings.json"))["packages"])')
```

"安装成功"只代表 pi 把它写进了 `settings.json`。还要确认扩展文件真的在
`pi.extensions` 指的位置，并且加载后能读到用户配置（`/net-resume` 的状态里会打印
实际使用的配置路径）。

### 日常维护注意

* 绝不提交运行时状态：`.pi/tasks/`、`.pi/settings.json`、`*.bak.*`、
  `__pycache__/`、`node_modules/`、`*.tgz`。`.gitignore` 已覆盖，提交前扫一眼
  `git status --short`。
* `wifi-fastlink` 刻意**不进** npm tarball（它需要 systemd 服务和 NetworkManager，
  npm 装不了这种依赖）。保持这样，并让它的适用范围一直写在
  `wifi-fastlink/README.md` 里。
* 两份 README 都是中英双语、英文在前，要保持同步；两半的章节编号是镜像的。
* 跨目录、跨语言半区的相对链接很容易写坏，快速检查：

  ```bash
  python3 - <<'PY'
  import re, pathlib
  for md in pathlib.Path(".").rglob("*.md"):
      if ".git" in str(md) or "node_modules" in str(md): continue
      for link in re.findall(r"\]\((?!https?:|#)([^)]+)\)", md.read_text(encoding="utf-8")):
          t = (md.parent / link.split("#")[0]).resolve()
          if not t.exists(): print(f"{md}: {link}")
  PY
  ```
