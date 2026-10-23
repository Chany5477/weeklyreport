# 部署说明：每周五自动更新的 A 股周报

最终网址（部署完成后）：

```
https://<你的环境ID>.tcloudbaseapp.com/weeklyreport/
```

分工：

- **GitHub**：放源码 + 每周五 15:35 定时跑一次（抓数据、校验、生成页面）
- **腾讯云 CloudBase 静态托管**：放网页本身，国内访问快，路径挂在 `/weeklyreport`
- **不需要数据库**：每周一期就是一个 JSON 文件，历史存在 `data/history/`

---

## 一次性准备（约 15 分钟，做完以后全自动）

### 第 1 步：建 GitHub 仓库

1. 打开 https://github.com/new
2. Repository name 填 `weeklyreport`，选 **Public**，勾 **Add a README**
3. 点 Create repository

建好后，把本目录里的文件上传进去。**最简单的做法**是用 GitHub Desktop（很适合不熟悉命令行的情况）：

- 安装 https://desktop.github.com/
- File → Add Local Repository → 选这个文件夹 `/Users/chany/CodeBuddy/20261018224222`
- 左下角填 Summary（随便写「init」）→ Commit to main → Push origin

或者用命令行（我已经在本地帮你 `git init` 并提交过了，你只需要接上远端）：

```bash
git remote add origin https://github.com/<你的用户名>/weeklyreport.git
git branch -M main
git push -u origin main
```

### 第 2 步：拿腾讯云 API 密钥

1. 打开 https://console.cloud.tencent.com/cam/capi
2. 新建密钥，得到 **SecretId** 和 **SecretKey**（SecretKey 只在创建时显示一次，先复制下来）

### 第 3 步：找 CloudBase 环境 ID

1. 打开 https://tcb.cloud.tencent.com/dev
2. 进入你现在用的那个环境（跟「生命管理器」「股票助手」同一个就行）
3. 环境 ID 是一串形如 `xxx-1a2b3c4d` 的字符串，复制下来

> 不用新建环境。这个周报会部署到 `/weeklyreport` 子目录，不会覆盖你原来的页面。

### 第 4 步：把三个密钥放进 GitHub

进入你的仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，依次添加：

| Name | Value |
|---|---|
| `TCB_SECRET_ID` | 第 2 步的 SecretId |
| `TCB_SECRET_KEY` | 第 2 步的 SecretKey |
| `TCB_ENV_ID` | 第 3 步的环境 ID |

### 第 5 步：打开 Actions 的写权限

仓库 → **Settings** → **Actions** → **General** → 拉到最下面：
- Workflow permissions 选 **Read and write permissions**
- 保存

---

## 第 6 步：手动跑一次验证

仓库页面 → **Actions** → 左侧选 `weekly-review` → 右上角 **Run workflow** → 点绿色的 Run workflow。

等 1–2 分钟，变成绿色对勾就成功了。然后打开：

```
https://<你的环境ID>.tcloudbaseapp.com/weeklyreport/
```

如果报错，把红色那一步的日志截图发我，我改。

---

## 以后怎么用

- **自动**：每周五 15:35 跑一次；16:10、17:30 各补跑一次。你在手机 Safari 打开那个网址就是最新一期。
- **加到主屏幕**：Safari 打开网址 → 底部分享按钮 → 「添加到主屏幕」。之后桌面上有个图标，点开就是它，跟小程序一样。
- **数据没取齐时**：不发布、保留上一期；同一天还会自动补跑两次。如果当晚还没更新，去 Actions 点一次 Run workflow 手动补。

---

## 常见问题

**Q：GitHub 是境外服务器，能抓到国内行情数据吗？**
腾讯、东财的行情接口境外可访问；申万官网偶尔会慢。所以脚本每次抓数最多重试 3 次、每次间隔 5 分钟，再加上一天三次定时，基本能取齐。真取不齐也不会发错数据——会保留上一期并在日志里写明缺什么。

**Q：每周的 JSON 会不会越攒越多？**
会，但一个文件只有十几 KB，攒十年也没什么，而且它就是你自己的历史数据库。

**Q：能绑我自己的域名吗？**
可以。CloudBase 静态托管 → 基础配置 → 自定义域名，绑完就是 `https://你的域名/weeklyreport/`。

**Q：想换掉那个子目录名？**
改 `.github/workflows/weekly.yml` 最后一行的 `weeklyreport` 即可。
