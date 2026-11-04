# 拾语 · 独立部署交付

这条分支保留腾讯云模式，增加 `standalone` 模式。独立版不需要腾讯云账号、网关或云存储；仅需要 Docker Compose、自己的 PostgreSQL 和私有原件卷。AI/OCR 仍使用配置的外部接口，不是离线模型。

## 已构建镜像包

解开 `PhraseNest-standalone-linux-amd64.zip`，验证 SHA256SUMS，然后：

```sh
docker load -i images-linux-amd64.tar.gz
mkdir source
tar -xzf source.tar.gz -C source
cd source/deploy/standalone
node setup.mjs
```

如果主机只有 Docker、没有 Node，可替代最后一行为：

```sh
docker run --rm -v "$PWD:/bundle" --entrypoint node phrasenest:standalone /bundle/setup.mjs
```

编辑刚生成的 `.env`：填写模型/OCR 接口配置、`ZHIBI_PUBLIC_ORIGIN`。不要把配置发送给别人或放到 GitHub。默认只监听本机 `127.0.0.1:3000`；正式访问由服务器已有 HTTPS 反向代理转发，流式聊天不要开启代理缓冲。若需要内网直连，显式修改 APP_BIND 和公开来源地址，并设置服务器防火墙。

## 首次初始化和迁移

空库先初始化，不启动网页和后台任务：

```sh
docker compose up -d postgres
docker compose run --rm --no-deps init
mkdir -p migration
```

把加密的 `migration.pnbak` 和单独保管的 `migration.pnkey` 放到本机 `migration/`（不是公共下载包）。导入只允许空业务库，已有数据不会被覆盖：

```sh
docker compose run --rm --no-deps --user root --entrypoint node app standalone/permissions.mjs
docker compose run --rm --no-deps -e PHRASENEST_MIGRATION_KEY_FILE=/migration/migration.pnkey --entrypoint node app standalone/cli.mjs restore /migration/migration.pnbak
docker compose run --rm --no-deps --entrypoint node app standalone/cli.mjs verify
docker compose up -d --no-build --pull never
```

Compose 中的 init 会读取版本记录，只补未应用的建表脚本，不自动重导入或重置账号。迁移完成后使用原账号密码；管理员入口 `/admin/login`，新建首个管理员使用 `.env` 中 ADMIN_BOOTSTRAP_CODE。真实资料、对话与登录哈希仅存在于私有迁移包和持久卷，不在应用镜像里。

源站迁移导出是只读的双轮一致性检查：源表变化则中止。正式迁移窗口应暂停源站写入并重新导出；导出完成之后的旧站新增内容不会自动同步到新站。旧站不删除、不切流，目标服务器验收后另行决定域名切换。没有目标服务器时，“归档准备好”不代表“新服务器已迁移完成”。

## 从源码构建 / ARM 主机

```sh
cd deploy/standalone
node setup.mjs
docker compose build app init
docker compose up -d
```

下载镜像包是 Linux amd64；ARM 主机请使用源码在目标架构重新构建，不能把 Windows 本机构建目录当成 Linux 镜像。

## 定时任务

worker 跟随应用常驻，不依赖学生打开网页。默认同步已有学习证据，不主动运行付费模型任务。需要启用定时学伴任务、后台 OCR 入库时，设置 `STANDALONE_RUN_MODEL_TASKS=1`，并按需设置 `LIBRARY_BACKGROUND_ENABLED=1`，更新容器配置。这些操作会按你的 API 账户实际计费。

## 备份与更新

```sh
docker compose stop worker app
docker compose run --rm --no-deps -e PHRASENEST_MIGRATION_KEY_FILE=/migration/migration.pnkey --entrypoint node app standalone/cli.mjs backup /migration/backup-new-date.pnbak
docker compose up -d --no-build --pull never
```

归档文件名必须是新的，不会覆盖旧备份。备份和密码应分开保存，并复制到另一台设备。需要恢复时，对新的空目标库执行 restore + verify；不要以恢复演示为由清空原库。

应用更新只替换镜像；`database`、`originals` 两个命名卷保存数据。**不要运行 `docker compose down -v`**，它会删除持久卷。数据库端口不映射到公网；原件目录不作为静态目录公开。数据库与原件请放在同一台可靠主机的持久磁盘，并定期测试恢复。

流程依据：[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)、[PostgreSQL 官方镜像](https://hub.docker.com/_/postgres)。
