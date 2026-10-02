# 1Panel 部署指南（先构建镜像 + 编排 · 外部 WAF 反向代理）

这份指南对应你的实际架构：

```
学生手机 / 教室大屏
        │  https://你的域名
        ▼
   WAF（防火墙 / swamwaf）      ← 域名、证书、HTTPS 全在这层，容器里不碰
        │  http://服务器IP:3000  ← 回源
        ▼
   1Panel 里的 classroom-app 容器
```

**容器里只做一件事：在 3000 端口上跑服务。** 域名、证书、反代都不归它管。

---

## 先说「镜像拉取失败」是怎么回事

你这次的报错日志已经把答案写得很清楚了：

```
08:40:33 开始拉取镜像 [classroom-interactive:1.0.0]
08:41:54 拉取镜像 失败 : ...Error response from daemon: error from registry: denied
```

**1Panel 创建编排时会先自己执行一步「预拉取」**：把编排文件里 `image:` 声明的
镜像逐个 `docker pull` 一遍（1Panel 源码 `agent/utils/compose/compose.go` 的
`UpWithTask → PullComposeImages`）。只有**本地已经存在**的镜像才会被跳过，
否则就去 Docker Hub 拉——而 `classroom-interactive:1.0.0` 是本地构建出来的，
Docker Hub 上根本没有，所以拉取被拒绝（denied），任务中止。

**两个关键结论：**

1. **`pull_policy: build` 对 1Panel 无效。** 它管的是命令行 `docker compose up`
   的行为，1Panel 的预拉取根本不解析这个字段。之前版本指南里把它当解药，
   是基于错误推断，这次拿到真实日志和源码才纠正过来。
2. **解法是把顺序反过来：先把镜像构建到服务器上，再创建编排。**
   镜像已存在 → 预拉取跳过 → `compose up -d` 直接用本地镜像 → 全程不碰 Docker Hub。

### 另一个潜在问题：基础镜像 `node:22-alpine` 拉不下来

构建镜像本身需要先拉基础镜像，国内服务器访问 Docker Hub 经常超时。

**修法（推荐，一次配好长期有效）**：
1Panel → 容器 → 配置 → **镜像加速** → 填入加速地址，保存后重启 Docker 服务。

多填几个，Docker 会按顺序试：

```json
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://mirror.ccs.tencentyun.com",
    "https://hub-mirror.c.163.com",
    "https://docker.mirrors.ustc.edu.cn"
  ]
}
```

填完在 SSH 里验证（配对了会很快返回）：

```bash
docker pull node:22-alpine
```

**临时绕法**（不想改守护进程配置时）：Dockerfile 里基础镜像地址已做成可替换参数，
构建时传一下即可：

```bash
docker build --build-arg NODE_IMAGE=docker.1ms.run/library/node:22-alpine \
  -t classroom-interactive:1.0.0 /opt/classroom-interactive
```

---

## 第 1 步：上传源码

1Panel → **文件** → 进 `/opt` → 上传 `deploy/classroom-interactive-deploy.zip`
→ 右键解压 → 得到 `/opt/classroom-interactive`

> 这个包由 `npm run pack` 生成（Windows / macOS / Linux 都能跑），
> 已排掉 `node_modules`、`test/`、`shots/`、`data/rooms/`。
> 以后改了代码要更新部署，重新 `npm run pack` 再传一次即可。

解压后确认这几个文件在：

```bash
ls /opt/classroom-interactive
# 应看到：Dockerfile  package.json  server/  public/  deploy/docker/
```

## 第 2 步：放行 3000 端口（给 WAF 回源用）

**放两处，是两个独立开关，漏一个都连不上：**

| 位置 | 操作 |
| --- | --- |
| 云厂商安全组 | 入站放行 TCP 3000 |
| 1Panel 防火墙 | 系统 → 防火墙 → 端口规则 → 添加 TCP 3000 |

> **建议**：用云 WAF 时，把 3000 的来源 IP 限制成 WAF 的回源 IP 段，
> 别对全网开放——否则别人可以直接用 `http://IP:3000` 绕过 WAF 打开你的控制端。
> 如果 WAF 和本项目在同一台机器上，更省事：把编排里的端口改成
> `"127.0.0.1:3000:3000"`，只监听本机。

## 第 3 步：构建镜像（这一步必须在创建编排之前）

二选一：

**方式 A（推荐，面板操作）**：1Panel → **容器** → **镜像** → **构建镜像**

| 配置项 | 值 |
| --- | --- |
| Dockerfile 路径 | `/opt/classroom-interactive/Dockerfile` |
| 构建上下文目录 | `/opt/classroom-interactive` |
| 镜像名称 | `classroom-interactive:1.0.0` |

点构建，等它跑完（首次 **2–5 分钟**，主要在 npm 装依赖）。

**方式 B（SSH）**：

```bash
docker build -t classroom-interactive:1.0.0 /opt/classroom-interactive
```

无论哪种方式，**构建完先确认镜像在本地**：

```bash
docker images | grep classroom-interactive
# classroom-interactive   1.0.0   <ID>   <时间>   <大小>
```

镜像名必须**一字不差**是 `classroom-interactive:1.0.0`——1Panel 预拉取就是按
编排里的 `image:` 值检查本地镜像的，标签对不上它会以为没有、照样去拉。

## 第 4 步：建编排

1Panel → **容器** → **编排** → **创建编排**

- **名称**：`classroom`
- **编排内容**：把 `deploy/docker/docker-compose.run.yml` 整段粘贴进去
  （解压后路径是 `/opt/classroom-interactive/deploy/docker/docker-compose.run.yml`）
- ⚠️ **不要勾选「强制拉取镜像」**。勾了它就会无条件 `docker pull`，
  本地有镜像也照样报 denied。

这份编排**没有 `build` 段、只有 `image:`**——1Panel 预拉取发现
`classroom-interactive:1.0.0` 已存在 → 跳过 → `compose up -d` 直接用本地镜像。
整个过程不碰 Docker Hub。

点确定后看进度：容器 → 编排 → 点 `classroom` → 日志。这次应该直接是
「使用已存在镜像」然后创建容器，不会再出现「开始拉取镜像」。

> ⚠️ **别粘错文件。** 解压后的目录里有三份 compose，只有这一份是给 1Panel 用的：
>
> | 路径 | 用途 | 1Panel 编排里该用吗 |
> | --- | --- | --- |
> | `deploy/docker/docker-compose.run.yml` | **1Panel 专用**：无 build 段，先构建镜像再起 | ✅ **就这份** |
> | `deploy/docker/docker-compose.yml` | 命令行 `docker compose up --build` 用 | ❌ 1Panel 预拉取对 pull_policy 无效，老 Compose 还不认这个字段 |
> | `docker-compose.yml`（根目录） | 命令行 `docker compose up --build` 用（context 是相对路径） | ❌ |

## 第 5 步：配 WAF 反向代理

在你的 WAF 上加一条站点 / 规则：

| 配置项 | 值 |
| --- | --- |
| 对外域名 | `kt.example.com`（换成你的） |
| 回源协议 | **HTTP** |
| 回源地址 | `服务器IP` |
| 回源端口 | `3000` |
| 证书 | 在 WAF 上配（容器里不装证书） |

### ⚠️ 必须开启 WebSocket

**这是最容易漏、也最影响课堂体验的一项。**
WAF 默认常常不转发 `Upgrade` 头，Socket.IO 会退化成长轮询：
能连上，但弹幕飞入、抢答排名会明显发飘，投票也要等一下才更新。

在 WAF 上找到类似 **「WebSocket 支持」/「协议升级」** 的开关，打开它。
如果没有这个开关，需要在转发规则里放行这两个请求头：

```
Upgrade: websocket
Connection: Upgrade
```

**验证方法**（在能访问域名的机器上执行）：

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
     "https://你的域名/socket.io/?EIO=4&transport=websocket"
```

- ✅ 期望：`HTTP/1.1 101 Switching Protocols`
- ❌ 若是 `200 OK` 或直接断开：WebSocket 没通，回去开开关

### 另外三条容易踩的

1. **不要给 `/socket.io/` 开缓存或内容改写**——长连接被缓存会直接连不上。
2. **回源超时设长一点**（≥ 60s，能设 3600s 更好），Socket.IO 是长连接。
3. **别开只放行 GET/POST 的方法白名单**，会影响 Socket.IO 握手。

## 第 6 步：部署后自检

### ⓪ 先跑自动化自检（一条命令，30 秒）

```bash
cd /opt/classroom-interactive
bash scripts/selfcheck.sh
```

它会依次检查：容器是否在跑 → `/healthz` 的持久化与二维码地址 →
**服务实际吐出来的 JS 里有没有新功能的代码** → 磁盘上的服务端文件 →
WebSocket 能否升级成 101。哪一项不对就打印对应的修法，退出码非 0
（也可以挂在部署流水线里当门禁）。

想连公网入口一起验（顺带确认证书和 WAF 反代正常）：

```bash
BASE=https://你的域名 bash scripts/selfcheck.sh
```

> **为什么要有这一步**：本项目踩过两次「以为部署成功、实际跑的是旧包」——
> 新功能早就在代码里写好了，但没重新打包或没重启容器，页面上什么新按钮都没有，
> 而界面上没有任何地方会提示"你用的是旧版本"。
> 所以自检脚本不问版本号，而是直接问跑着的服务：**你有没有这个功能？**

下面 4 项是人工复核，脚本查不到（脚本只能验证技术事实，验不了"好不好用"）。

```bash
curl https://你的域名/healthz
```

```json
{
  "ok": true,
  "persistent": true,
  "qrBase": "https://kt.example.com",
  "qrBaseSource": "x-forwarded-host"
}
```

**`persistent` 必须是 `true`**。`false` 说明数据卷权限不对，数据只在内存里，
容器一重启这节课的积分全没。

### ② 二维码地址必须对（这条最容易错，别跳过）

看上面返回的 **`qrBase`**——它就是学生扫码后手机真正打开的地址。

| qrBase 是什么 | 说明 |
| --- | --- |
| `https://你的域名` | ✅ 正确，不用管 |
| `http://127.0.0.1:3000` 或 `http://内网IP:3000` | ❌ WAF 没转发 `X-Forwarded-Host`，学生扫了打不开 |

不对的话，在 1Panel 里改一行环境变量就行，**不用重新构建镜像**：
容器 → 找到 `classroom-app` → 编辑 → 环境变量 → 把
`PUBLIC_BASE` 改成 `https://你的域名` → 重启容器。

> 为什么你说「不放域名」、这里又要填：二维码是服务端生成的，
> 服务端不知道外面套了哪层 WAF。WAF 转发了 `X-Forwarded-Host` 时能自动猜对；
> 没转发就只能你告诉它。这里填的是**对外访问地址**，不是容器内部配置，
> 不影响 WAF 那层的域名和证书。

### ③ 手机走流量访问一次

别在服务器本机浏览器测——本机通不代表公网通。
用手机**关掉 WiFi**，浏览器打开 `https://你的域名/healthz`。

这一步能一次性验完：域名解析 + WAF 转发 + 安全组 + 容器，整条链路。

### ④ 两部手机真机走一遍

| 角色 | 地址 |
| --- | --- |
| 教师控制端 | `https://你的域名/c` |
| 大屏 | `https://你的域名/w?room=ABCDEF` |
| 学生 | `https://你的域名/m?room=ABCDEF`（扫码进，不用手输） |

两部手机各扫一次码加入 → 控制端发一个投票 → 看大屏柱状图实时涨 →
再发一个词云 → 看手机上输入后大屏是否飘出弹幕。

**这一步建议无论如何走一遍**，它能一次性验完二维码、WebSocket、
广播、跨设备同步。前面几项都过了、唯独没做这步就上课，仍然可能翻车。

---

## 日常运维

```bash
# 看日志
docker logs -f classroom-app

# 重启 / 停止
docker restart classroom-app
docker stop classroom-app
```

数据在命名卷 `classroom-data` 里，**重新构建容器不会丢**。

### 更新代码后重新部署

**走 bind mount（改了源码，只需覆盖文件）：**

```bash
cd /opt/classroom-interactive
# 上传新包并解压覆盖（覆盖解压不会补缺失的子目录，目录有缺就先删旧的再解压）
unzip -o classroom-interactive-deploy.zip

docker restart classroom-app

# 验证新代码确实生效了——别跳过，这一步抓的就是"部署了旧包"
bash scripts/selfcheck.sh
```

**没走 bind mount（源码是 COPY 进镜像的）：**

```bash
cd /opt/classroom-interactive
# （上传新代码覆盖到本目录）

# 重新构建镜像（镜像名、上下文都不能变）
docker build -t classroom-interactive:1.0.0 /opt/classroom-interactive

# 重建容器
docker compose up -d

bash scripts/selfcheck.sh
```

1Panel 界面里也可以：容器 → 编排 → 点 `classroom` → 重建。

### 备份

```bash
docker run --rm -v classroom-data:/data -v /opt/backup:/backup \
  alpine tar czf /backup/classroom-$(date +%F).tar.gz -C /data .
```

### 想清空某节课的数据

```bash
docker exec classroom-app rm -f /app/data/rooms/ABCDEF.json
```

---

## 排错表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 创建编排时「开始拉取镜像 [classroom-interactive:1.0.0]」→ denied | 1Panel 预拉取镜像，但镜像还没构建到本地 | **先**用 1Panel「构建镜像」或 `docker build` 把镜像构建出来，再创建编排 |
| 预拉取时提示「使用已存在镜像」但容器没起来 | 镜像 tag 对不上（如 built 成 latest） | `docker images` 确认是 `classroom-interactive:1.0.0`，`docker tag` 改过来 |
| 创建编排时勾了「强制拉取镜像」 | 无条件 docker pull，本地有镜像也失败 | 创建时**不要勾**；已建的编排在「编辑」里重来 |
| 构建镜像卡在 `FROM docker.io/library/node:22-alpine` | Docker Hub 连不上 | 配镜像加速；或用 `--build-arg NODE_IMAGE=...` |
| 构建报 `COPY server ./server` / `COPY public ./public` 找不到源 | 构建上下文里没有 `server/`、`public/` 目录（上传/解压不完整，或上下文目录填错） | SSH 跑 `ls /opt/classroom-interactive`，确认有 `server` 和 `public`；缺就重新上传 zip 完整解压；并核对「构建上下文目录」填的是 `/opt/classroom-interactive` |
| 容器起不来，日志 `EACCES` | 卷权限 | 确认用命名卷 `classroom-data`，不是宿主目录 |
| `/healthz` 里 `persistent: false` | 数据目录不可写 | 同上，换成命名卷 |
| 手机打不开，服务器本机 curl 通 | 端口没放行 | 云安全组 + 1Panel 防火墙，两个都放 |
| 页面能开，但投票/弹幕要等几秒才动 | WebSocket 没通 | WAF 开 WebSocket，用 curl 验 101 |
| 扫码打不开，qrBase 是内网 IP | WAF 没转发 Host 头 | 设 `PUBLIC_BASE=https://你的域名` |
| 大屏一直转圈 | 大屏地址没带课堂码 | 用 `/w?room=ABCDEF`，从控制端点「打开大屏」最省事 |
| 功能都对，但页面上找不到新加的按钮 | **跑的是旧包**：没重新打包、没覆盖文件，或覆盖了但没重启容器 | 跑 `bash scripts/selfcheck.sh`，它会直接告诉你哪个文件是旧版 |
| 自检脚本说磁盘文件是新版，但服务吐出来的还是旧代码 | 源码没挂进容器（bind mount 缺失），或改了源码却只 restart 没重建镜像 | 未挂源码时必须 `docker build` 重建镜像 |

---

## 安全提醒

控制端 `/c` 只要知道地址就能打开。建议二选一：

1. 在 WAF 上给 `/c` 配访问密码或 IP 白名单（限校园网网段）
2. 保管好课堂码，别外传

编排里默认开着 `DISABLE_ROOM_LIST=1`，已关掉全量房间列表接口。
