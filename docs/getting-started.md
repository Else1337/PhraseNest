# 本地运行与源码说明

本仓库不是界面样板：页面、API、Agent 工具、原生记忆适配、资料解析检索、学习证据与画像均来自拾语当前开发代码。这里发布独立的源码快照，不合并原私有仓库历史，也不读取或导入线上数据库。

## 本地启动

需要 Node.js 22.13 或更新版本、npm 和 Git。

```bash
git clone https://github.com/Else1337/PhraseNest.git
cd PhraseNest
npm ci
cp .env.example .env.local
npm run dev
```

Windows PowerShell 把复制命令换为 `Copy-Item .env.example .env.local`。浏览器打开 `http://127.0.0.1:3002/login`，注册自己的本地学生账号。不要使用或猜测演示截图中的线上账号。

本地开发默认把数据写入被 Git 忽略的 `data/`，不需要连接拾语线上服务。没有模型密钥时可以检查页面与本地账号；AI 回答、OCR 和语义向量需要各自的服务配置。

## 最少配置什么

- 文本对话：`DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`、`DEEPSEEK_TEXT_MODEL`。使用你实际有权限调用的模型。
- 图片与扫描 OCR：`DASHSCOPE_API_KEY` 和实际可用的 OCR 模型。
- 语义检索：`AI_EMBEDDING_BASE_URL`、`AI_EMBEDDING_API_KEY`、`AI_EMBEDDING_MODEL`。不配置不等于已经启用语义检索。
- 登录与学习资料：本地使用文件存储；独立 PostgreSQL 或 CloudBase 模式需配置存储环境并迁移结构。

不要把任何密钥放进 `NEXT_PUBLIC_*`、源码或公开 issue。`.env.example` 中的本机数据库口令仅是开发占位，不是任何线上凭据。

## 主要目录

```text
src/app/                  页面、API 与样式
src/components/           对话、阅读纸张、画像、资料库、教师端
src/lib/ai/               Mastra Agent、记忆、上下文、工具、用量
src/lib/learner/          原句证据、追踪扫描、Reflector、画像与变化
src/lib/library/          上传、解析、后台任务、索引和检索
src/lib/storage/          本地、PostgreSQL、CloudBase 持久化适配
skills/                   英语精讲与作文批改方法
cloudbase/migrations/     共享 PostgreSQL 结构迁移
cloudfunctions/           私有后台定时唤醒入口
deploy/node/              容器与反向代理配置
tests/                    本地开发测试
```

## 构建和维护

```bash
npm run build
npm run start
npm run skills:check
```

默认构建采用 Next.js Webpack / Node.js 路径。启动地址仍为 3002。可选 Vinext / Cloudflare 代码保留供研究，其资源绑定使用占位值，并不代表已替你创建资源。`package.json` 的 `private: true` 仅阻止误发布到 npm，不影响 GitHub 源码公开。

`npm test` 是持续迭代中的开发测试集，不是承诺全绿的稳定发行版验收。少量依赖私人部署脚本的验收文件、线上账号测试、历史导入/发布/备份脚本不在公开包内。本次公开不额外消耗模型额度。

## 生产部署并非复制环境变量就结束

`deploy/node/Dockerfile` 的入口会检查持久化存储和迁移回执；缺少配置会拒绝启动，不会用空库覆盖历史数据。云端模式必须由部署者在自己的环境内完成数据库结构迁移、私有原件存储和数据迁移校验。

共享 PostgreSQL 的迁移脚本包含服务端网关权限设计，需要使用服务端角色；不要把网关管理凭据交给浏览器。定时任务需要部署独立的私有唤醒函数或后台工作进程，不能依赖可能缩容至零的 Web 容器自身计时。

原工程中少量 `else` 范围检查与迁移回执属于早期单账号上线策略，并非密码或公开测试账号。多用户生产部署需要按自己的授权策略审查，不应直接沿用。框架依赖、结构和功能已公开，不代表任意环境可以零配置上线。

## 本次公开适配

保留真实业务代码，移除运行数据、账号验收文件、环境凭据、旧数据快照与个人对话摘录。私人 Notion 地址和原稿入口替换为通用说明，相关 Skill 编译产物同步更新。默认构建命令改为可移植的 Node.js 路径，移除依赖开发者私有目录的 npm 入口。

已知问题见[问题复盘](known-issues.md)。源码公开但尚未指定开源许可证，不包含第三方校本资料的再分发授权。

[返回主页](../README.md)
