# 课堂互动系统 · 1Panel 部署指南

> 适用：已在 1Panel 上管理服务器，准备把系统放到公网给真实课堂使用。
> 全程约 20 分钟，其中大部分时间花在等镜像构建。

---

## 零、先搞清楚要部署什么

单容器，无数据库，无 Redis：

```
学生手机 ──┐
教师电脑 ──┼──► 1Panel OpenResty (443) ──► classroom-app 容器 (3000)
大屏电脑 ──┘
```

- **只有一个容器要跑**（`classroom-app`），数据以 JSON 快照存在卷里。
- **项目里不再带 nginx 编排**。1Panel 自带 OpenResty 已经占了 80/443，
  再起一个 nginx 容器会端口冲突。用 1Panel 自己的「网站 → 反向代理」即可。
- 服务器放行端口：先开 `3000`（验证用）+ `80/443`（正式访问）。
  正式跑通后建议把 3000 改成只监听 127.0.0.1，并在防火墙关掉外网访问。

> 若你的域名和 HTTPS 放在**外部 WAF**（如 swamwaf）上，不打算用 1Panel 的
> OpenResty，请改看 [`部署指南-1Panel-Docker.md`](部署指南-1Panel-Docker.md)，
> 那一份更贴合「容器只跑服务、外层另有 WAF」的架构。

---

## 一、上传源码

### 1.1 本地打一个干净的包

在项目根目录执行：

```bash
npm run pack
```

产出 `deploy/classroom-interactive-deploy.zip`（约 29 个文件 / 126 KB），
脚本会自动排掉 `node_modules`、`test/`、`shots/`、`data/rooms/`——
`node_modules` 会在镜像里重新安装，其余都是本地开发自检用的。

没有 npm 环境时手动打（Git Bash / macOS / Linux）：

```bash
zip -r classroom-interactive.zip . \
  -x "node_modules/*" "test/*" "shots/*" "data/rooms/*" ".git/*" "*.log" "deploy/*"
```

### 1.2 上传到服务器

1Panel → **文件** → 进入 `/opt` → 上传 → 选中 zip → 右键「解压」

得到 `/opt/classroom-interactive/`，确认里面能看见
`Dockerfile`、`docker-compose.yml`、`server/`、`public/`、`package.json`。

---

## 二、构建镜像并创建编排

> ⚠️ **1Panel 创建编排时会先自己预拉取编排里 `image:` 声明的镜像**
> （源码 `agent/utils/compose/compose.go`），`pull_policy` 对它无效。
> 所以顺序必须是：**先把镜像构建到本地，再创建编排**。

### 2.1 构建镜像

二选一：

- 1Panel → **容器 → 镜像 → 构建镜像**：
  - Dockerfile：`/opt/classroom-interactive/Dockerfile`
  - 上下文目录：`/opt/classroom-interactive`
  - 镜像名称：`classroom-interactive:1.0.0`
- 或 SSH：`docker build -t classroom-interactive:1.0.0 /opt/classroom-interactive`

构建完确认：`docker images | grep classroom-interactive`

### 2.2 创建编排

1Panel → **容器 → 编排 → 创建编排**

- **名称**：`classroom`
- **来源**：选「编辑」，粘贴下面这份（**不要勾「强制拉取镜像」**）：

```yaml
services:
  app:
    image: classroom-interactive:1.0.0
    container_name: classroom-app
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      TZ: Asia/Shanghai
      PUBLIC_BASE: "https://class.你的域名.com"     # ← 唯一必须改的一行
      DISABLE_ROOM_LIST: "1"
    volumes:
      - classroom-data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  classroom-data:
```

> 这份配置在仓库里是 `deploy/docker/docker-compose.run.yml`（1Panel 主用）
> 和 `deploy/1panel/docker-compose.yml`（OpenResty 路线版），直接复制即可。
> 它没有 `build` 段：1Panel 预拉取发现镜像已存在就跳过，`up -d` 直接用本地镜像。

**关于 `PUBLIC_BASE`（唯一必须改的一行）**

它决定学生扫码后打开的地址，也就是二维码的内容。

- **有域名**：填全，含协议，末尾不要带斜杠 → `https://class.你的域名.com`
- **还没配域名**：先留空 `""`。系统会按你访问时用的 Host 自动推断，
  支持 X-Forwarded 头，走反代也能猜对。等域名配好再回来改。

### 为什么要改用命名卷 `classroom-data`，而不是挂 `./data` 目录

这是本项目最容易踩的部署坑，值得说清楚：

容器以非 root 用户（`node`，uid 1000）运行，而 bind mount 挂进去的宿主目录
通常是 root 建的、权限 755。此时建子目录直接 EACCES，**服务启动即崩溃**，
而报错信息离病因（卷权限）很远，很不好查。

命名卷会继承镜像内目录的属主，开箱即用。

> 代码层面已经做了兜底：即使目录真不可写，也会降级成「纯内存模式」继续跑，
> 课照样能上，并在日志和健康检查里明确告警（不会静默丢数据）。
> 所以万一卷配错了，你看到的是"能上但重启丢数据"，而不是"网站打不开"。

点「构建」或「启动」，等 2–5 分钟（首次要拉 node 镜像 + npm 安装）。

---

## 三、配置域名与 HTTPS

### 3.1 建站（如已有网站可跳过）

1Panel → **网站 → 创建网站 → 反向代理**
- 域名：`class.你的域名.com`
- 代理地址：`http://127.0.0.1:3000`

> 用 `127.0.0.1` 而不是容器名：1Panel 的 OpenResty 容器和你新建的应用容器
> **不在同一个 Docker 网络里**，用容器名 `app` 会连不上。

### 3.2 开启 WebSocket（关键）

1Panel → **网站 → 你的域名 → 反向代理** → 打开「**支持 WebSocket**」开关。

如果你的 1Panel 版本没有这个开关，或开了不生效：
**网站 → 配置 → 反向代理配置文件**，把 `deploy/1panel/openresty-proxy.conf`
的内容整段粘进去（那是 location 级片段，不要套 `server{}` 外层）。

**为什么这一步不能省**：Socket.IO 优先走 WebSocket，升级失败会退化成 HTTP 长轮询。
轮询也能用，但弹幕飞入、抢答排名这类"谁先谁后"的场景会明显发飘，
延迟从几十毫秒涨到几百毫秒——课堂上最影响体验的就是这个。

### 3.3 申请证书

1Panel → **网站 → 你的域名 → 证书 → 申请证书**（Let's Encrypt，需域名已解析到本机）
→ 开启「强制 HTTPS」。

> 系统本身不用摄像头、不用定位，HTTP 也能跑。但手机上会显示"不安全"红字，
> 学生第一眼观感不好，建议还是上 HTTPS。另外 iOS Safari 在 HTTP 下对
> localStorage 的策略更保守，可能影响"刷新后自动回到课堂"。

---

## 四、部署后自检（必做，5 分钟）

按顺序验一遍，任一项不通过就别急着上课。

### ① 容器活着，且持久化生效

浏览器打开 `https://class.你的域名.com/healthz`，应看到：

```json
{"ok":true,"rooms":0,"uptime":123.45,"persistent":true,"publicBase":"https://class.你的域名.com"}
```

**重点看 `persistent` 必须是 `true`**。如果是 `false`，说明卷权限不对，
数据在内存里、重启就丢——按第 5.1 节修。

### ② WebSocket 真的升级成功了

在你自己的电脑上执行（换成你的域名）：

```bash
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
  "https://class.你的域名.com/socket.io/?EIO=4&transport=websocket"
```

**正确结果**：第一行是 `HTTP/1.1 101 Switching Protocols`。
如果是 `200 OK` 或别的，说明上一节的 WebSocket 没配对，实时性会打折。

### ③ 二维码地址正确

1Panel → **容器 → classroom-app → 终端**，或在浏览器打开控制端 `/c` 建一个课堂，
然后访问 `https://class.你的域名.com/api/room/<课堂码>/qrcode.json`，
确认返回的 `url` 是 `https://class.你的域名.com/m?room=XXXXXX`。

如果返回的是 `http://127.0.0.1:3000/...`，说明反代没传 `X-Forwarded-*`
头，或 `PUBLIC_BASE` 没填——学生扫码会打不开。

### ④ 三个端都能打开

| 端 | 地址 | 用在哪 |
| --- | --- | --- |
| 教师控制端 | `/c` | 讲台电脑，发起点名/投票/转盘 |
| 大屏呈现端 | `/w?room=XXXXXX` | 投影仪，全屏显示 |
| 学生手机端 | `/m?room=XXXXXX` | 学生扫码进入 |

### ⑤ 真机走一遍

**这一步不要省，也别用一台手机模拟。**

用**两部不同的手机**扫码加入，在控制端发一个投票，两部手机都投，
看大屏柱状图的数字有没有实时涨上去。这一步能一次性验证：
二维码、WebSocket、广播、跨设备同步——全部链路。

---

## 五、出问题怎么查

### 5.1 `persistent` 是 false

数据卷权限不对。1Panel → **容器 → classroom-app → 终端**，执行：

```bash
ls -ld /app/data /app/data/rooms
```

属主不是 `node` 就说明卷挂错了。改用命名卷即可（见第二节）。
若坚持用目录挂载，需在宿主机执行 `chown -R 1000:1000 /opt/classroom-interactive/data`
后重启容器。

### 5.2 页面能开，但大屏数字不动

十有八九是 WebSocket 没升级。按第 3.2 节重配，然后用第 ② 步的 curl 复验。

### 5.3 学生扫码打不开

- 二维码内容是 `127.0.0.1` → `PUBLIC_BASE` 没填，或反代没传 X-Forwarded 头
- 提示"课堂不存在" → 课堂码过期或输错；让教师重新发一次二维码
- 手机能扫码但页面空白 → 大概率是 HTTPS 证书问题，检查证书是否覆盖该域名

### 5.4 想看服务日志

1Panel → **容器 → classroom-app → 日志**。
正常运行时应该很干净；如果每 2 秒刷一条 `[save] 写入失败`，就是卷权限问题。

---

## 六、日常运维

| 事项 | 怎么做 |
| --- | --- |
| 备份课堂数据 | 1Panel → **容器 → 卷 → classroom-data → 备份**，或直接打包 `/app/data/rooms` |
| 导出某节课积分 | 浏览器打开 `/api/room/<课堂码>/export.csv` |
| 更新版本 | 上传新源码 → 1Panel 编排里点「重新构建」→ 数据卷不受影响，课堂数据保留 |
| 清空某节课 | 删掉卷里对应的 `<课堂码>.json`，重启容器 |
| 课后不用管 | 房间数据一直留着（有意设计，方便回看积分），一学期也就几 MB |

### 一个安全建议

域名跑通后，把编排里的端口从

```yaml
- "3000:3000"
```

改成

```yaml
- "127.0.0.1:3000:3000"
```

这样服务只经 OpenResty 暴露，外面直接扫 `IP:3000` 扫不到，
同时可以省掉 3000 端口的防火墙策略。

---

## 附：如果 1Panel 编排不支持构建

少数 1Panel 版本的编排界面只支持拉取现成镜像、不支持 `build:`。两个办法：

**办法 A（推荐）：命令行构建**

1Panel → **终端**，进入项目目录执行：

```bash
cd /opt/classroom-interactive
docker compose -f deploy/1panel/docker-compose.yml up -d --build
```

**办法 B：本地构建后导入**

在有 Docker 的机器上 `docker build -t classroom-interactive:1.0.0 .`，
`docker save classroom-interactive:1.0.0 -o classroom.tar`，
再在 1Panel → **容器 → 镜像 → 导入** 上传，最后把编排里的 `build: .` 一行删掉即可。
