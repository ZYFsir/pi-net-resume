# Maintaining this repo

Notes for whoever works on this repository (currently just me). Users do not
need anything here — see [README.md](README.md) for install and usage.

**English** | [中文](#中文)

## Layout

```
pkg/pi-net-resume/      the extension -- single source of truth for both the npm
                        package and the tests; there is no second copy
wifi-fastlink/          the Linux/NetworkManager watcher, not published to npm
tests/                  offline test suites for both halves
package.json            repo-root shim so `pi install git:...` finds the extension
publish-package.sh      release gate + publisher
```

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

1. required package files are present
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

### Two ways to publish

**CI (preferred): OIDC trusted publishing.** `.github/workflows/publish.yml`
publishes when a `v*` tag is pushed, authenticating with a short-lived OIDC
token -- there is no `NPM_TOKEN` secret in this repository. The trust lives on
npmjs.com (package Settings -> Trusted Publisher -> GitHub Actions) and must
name this file exactly:

| Field | Value |
| --- | --- |
| Organization or user | `ZYFsir` |
| Repository | `pi-net-resume` |
| Workflow filename | `publish.yml` |
| Environment name | *(empty -- the workflow sets none)* |
| Allowed actions | leave the `npm publish` box **unchecked** (staged publishing only) |

```bash
git tag -a v1.1.0 -m "pi-net-resume 1.1.0"
git push origin v1.1.0          # the tag stages the release
npm stage list                  # find the stage id
npm stage approve <stage-id>    # publish it (prompts for OTP)
```

Note the two steps: the tag **stages**, a human **approves**. That is npm's
recommended setting and worth keeping, because a pi extension runs with full
system access -- an unattended publish path is a supply-chain risk for every
user. The price is one OTP per release, not per attempt.

Approval needs npm >= 11.15.0 locally (`npm install -g npm@latest`), or use the
package page on npmjs.com, which also offers approval. Rejecting with
`npm stage reject <stage-id>` discards a release that should not ship; nothing is
public until approval.

`./publish-package.sh --publish` still publishes directly with your own 2FA,
which is fine for a human-initiated release -- the staged requirement applies to
the CI trusted publisher, not to you.

Requirements, all enforced by the runner rather than assumed: `id-token: write`,
npm >= 11.15.0 for `npm stage` (the bundled npm is older, so the workflow upgrades it and then asserts the version), Node >= 22.14.0, and a GitHub-hosted
runner. Provenance attaches automatically for a public package from a public
repository.

**Local.** `./publish-package.sh --publish` still works and is the way to go when
you want to publish without tagging. It needs your npm credentials and, with 2FA
enabled, an OTP prompt -- which is likely why CI publishing is worth setting up.

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

- **Never reintroduce a second copy of `index.ts`.** There used to be one under
  `pi-net-resume/`, and `publish-package.sh` "synced" the two — in the direction
  that silently overwrote whichever one you had just edited. It destroyed a
  session's worth of implementation work. The tests and npm now share one file.
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
pkg/pi-net-resume/      扩展本体 —— npm 包与测试共用的唯一来源，没有第二份拷贝
wifi-fastlink/          Linux/NetworkManager 看门狗，不发布到 npm
tests/                  两半的离线测试
package.json            仓库根 shim，让 pi install git:... 能找到扩展
publish-package.sh      发布门禁 + 发布脚本
```

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

1. 包目录所需文件齐全
2. 两套测试（必须全过）
3. `package.json` 体检：`pi-package` 关键词、semver、`pi.extensions`、
   `files` 白名单、core 包不能出现在 `dependencies`、不能残留 `REPLACE_ME`
4. 用 **jiti** 真实加载（pi 的加载方式），并验证文档所述路径的配置确实被读到
5. tarball 内容 + 泄漏检查（`tests/`、`wifi-fastlink/`、`node_modules/`、`.pi/`）
6. 5b：仓库根 shim 能解析 —— git 安装是从 **clone 根**加载的，而 pi 没有子目录
   语法，shim 坏掉就意味着 `pi install git:...` **安装成功但什么都不加载**

发布到 npm 需要凭据（`npm login`），没有凭据脚本会拒绝发布。

#### 两种发布方式

**CI（推荐）：OIDC 可信发布。** `.github/workflows/publish.yml` 在推送 `v*` 标签时发布，
用短期 OIDC token 认证 —— **本仓库里没有任何 `NPM_TOKEN` 密钥**。
信任关系配置在 npmjs.com（包 Settings → Trusted Publisher → GitHub Actions），
必须与文件名完全一致：

| 字段 | 值 |
| --- | --- |
| Organization or user | `ZYFsir` |
| Repository | `pi-net-resume` |
| Workflow filename | `publish.yml` |
| Environment name | （留空 —— 本 workflow 未设置环境） |
| Allowed actions | **不要**勾选 `npm publish`（仅允许暂存发布） |

```bash
git tag -a v1.1.0 -m "pi-net-resume 1.1.0"
git push origin v1.1.0          # 打标签 = 送进暂存区
npm stage list                  # 找到 stage id
npm stage approve <stage-id>    # 批准上线（会要求 OTP）
```

注意这是**两步**：标签负责**暂存**，人负责**批准**。这是 npm 推荐的档位，值得保留 ——
因为 pi 扩展以完整系统权限运行，一条无人把关的发布通道对所有用户都是供应链风险。
代价是**每次发布一次 OTP**，而不是每次尝试一次。

批准需要本地 npm >= 11.15.0（`npm install -g npm@latest`），
或者直接用 npmjs.com 的包页面批准。要放弃某次发布用
`npm stage reject <stage-id>`；**批准之前不会有任何东西公开**。

`./publish-package.sh --publish` 仍是你自己带 2FA 的直接发布，
人工发起时这样没问题 —— 暂存要求针对的是 CI 的可信发布者，不是你自己。

前置条件（由 runner 强制，而非假设）：`id-token: write`、
npm >= 11.15.0（`npm stage` 需要；runner 自带的 npm 太旧，workflow 会升级并断言版本）、
Node >= 22.14.0、必须用 GitHub 托管的 runner。公开仓库 + 公开包会自动生成 provenance。

**本地发布。** `./publish-package.sh --publish` 依然可用，适合不想打标签时。
它需要你的 npm 凭据；开了 2FA 会要求输入 OTP —— 这大概就是你该用 CI 发布的理由。

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

* **绝不要重新引入 `index.ts` 的第二份拷贝。** 以前 `pi-net-resume/` 下有一份，
  而 `publish-package.sh` 会"同步"两者 —— 同步方向恰好是**静默覆盖你刚编辑的那一份**，
  已经毁掉过一整轮实现工作。现在测试与 npm 共用同一个文件。
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
