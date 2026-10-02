#!/usr/bin/env bash
#
# 部署后自检：在服务器上跑一遍，让服务器自己告诉你这次部署对不对。
#
# 为什么要有这个脚本：本项目经历过两次「用户以为部署成功、实际跑的是旧包」——
# 新功能早就在代码里写好了，但没重新打包 / 没重启容器，页面上一个新按钮都没有，
# 而界面上没有任何地方会提示「你用的是旧版本」。
# 与其靠人肉眼核对版本号，不如直接问跑着的服务：你有没有这几个新功能？
#
# 用法（在容器所在的服务器上）：
#   bash scripts/selfcheck.sh                      # 默认检查 http://127.0.0.1:3000
#   BASE=https://你的域名 bash scripts/selfcheck.sh  # 顺带验公网入口与证书
#   SRC=/opt/classroom-interactive bash scripts/selfcheck.sh   # 源码目录不在默认位置时
#
# 退出码：全部通过为 0，有任何一项失败为 1（可用于部署流水线里做门禁）。

BASE="${BASE:-http://127.0.0.1:3000}"
SRC="${SRC:-/opt/classroom-interactive}"
CONTAINER="${CONTAINER:-classroom-app}"

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 源码文件里有没有某段代码（用于确认磁盘上的文件已经是新版）
has_in_file() {
  if [ -f "$1" ] && grep -q "$2" "$1" 2>/dev/null; then return 0; fi
  return 1
}
# 服务实际吐出来的文件里有没有某段代码（用于确认**跑着的**是新版，而不仅是磁盘上是新版）
served_has() {
  local body
  body="$(curl -s --max-time 10 "$BASE$1" 2>/dev/null)"
  if [ -z "$body" ]; then return 1; fi
  case "$body" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

printf '\n\033[1m课堂互动系统 · 部署自检\033[0m\n'
printf '  服务地址 %s\n' "$BASE"
printf '  源码目录 %s\n' "$SRC"

# ---------------------------------------------------------------- 1. 容器
head2 '[1] 容器状态'
if command -v docker >/dev/null 2>&1; then
  state="$(docker inspect -f '{{.State.Status}} ({{.State.Health.Status}})' "$CONTAINER" 2>/dev/null)"
  if [ -n "$state" ]; then
    case "$state" in
      running*) ok "容器 $CONTAINER 正在运行：$state" ;;
      *)        bad "容器 $CONTAINER 状态异常：$state"
                info "看日志：docker logs --tail 100 $CONTAINER" ;;
    esac
  else
    bad "找不到容器 $CONTAINER"
    info "看所有容器：docker ps -a | head"
    info "容器名不是它的话：CONTAINER=你的容器名 bash scripts/selfcheck.sh"
  fi
else
  info "本机没有 docker 命令，跳过容器检查（直接在宿主机上跑的？）"
fi

# ---------------------------------------------------------------- 2. 健康检查
head2 '[2] 服务健康 /healthz'
health="$(curl -s --max-time 10 "$BASE/healthz" 2>/dev/null)"
if [ -z "$health" ]; then
  bad "访问 $BASE/healthz 没有响应"
  info "服务没起来，或端口不通：curl -v $BASE/healthz"
  info "容器日志：docker logs --tail 50 $CONTAINER"
else
  ok "服务有响应"
  if printf '%s' "$health" | grep -q '"persistent":true'; then
    ok "持久化可用（persistent=true，数据会落盘）"
  else
    bad "持久化不可用（persistent=false）——重启后积分和座位会全丢！"
    info "九成是数据卷权限问题。用命名卷 classroom-data，不要挂 ./data 目录；"
    info "或执行 chown -R 1000:1000 你的数据目录"
  fi
  qrbase="$(printf '%s' "$health" | grep -o '"qrBase":"[^"]*"' | cut -d'"' -f4)"
  qrsrc="$(printf '%s' "$health" | grep -o '"qrBaseSource":"[^"]*"' | cut -d'"' -f4)"
  if [ -n "$qrbase" ]; then
    case "$qrbase" in
      https://*) ok "二维码地址是 HTTPS：$qrbase" ;;
      *)         bad "二维码地址不是 HTTPS：$qrbase"
                 info "学生用流量扫码打不开内网地址。请在环境变量里显式指定"
                 info "PUBLIC_BASE=https://你的域名 然后重建容器。" ;;
    esac
    case "$qrsrc" in
      env)               ok "二维码地址来源：你明确指定的 PUBLIC_BASE" ;;
      x-forwarded-host)  bad "二维码地址是按 WAF 传来的 Host 猜的（$qrsrc）"
                         info "建议显式设置 PUBLIC_BASE=https://你的域名，别让服务猜。" ;;
      host)              bad "二维码地址是按访问 Host 猜的（$qrsrc）"
                         info "说明没有走代理或没设 PUBLIC_BASE。教室内网建课堂时"
                         info "二维码会指向 192.168.x.x，学生扫码永远打不开。" ;;
    esac
  fi
fi

# ---------------------------------------------------------------- 3. 跑着的版本
head2 '[3] 实际运行的版本（最关键：防「部署了旧包」）'
# 每一项都对应一个本次新增的功能，缺一个就说明跑的不是这份代码
served_has /js/control.js publishQuestion \
  && ok "题库功能已生效（control.js 含 publishQuestion）" \
  || { bad "题库功能没有生效"; info "public/js/control.js 是旧版，重新解压覆盖并重启容器"; }

served_has /js/control.js togglePause \
  && ok "活动暂停功能已生效（control.js 含 togglePause）" \
  || { bad "活动暂停功能没有生效"; info "同上：覆盖 public/js/control.js 后 docker restart $CONTAINER"; }

served_has /js/mobile.js onSeatClick \
  && ok "换座 / 显示占用者已生效（mobile.js 含 onSeatClick）" \
  || { bad "换座功能没有生效"; info "public/js/mobile.js 是旧版"; }

served_has /js/common.js toastContainer \
  && ok "提示层已更新（common.js 含 toastContainer）" \
  || { bad "common.js 是旧版"; info "这个文件修了「手机端提示读不到内容」的问题"; }

served_has /js/wall.js 老师已暂停作答 \
  && ok "大屏暂停提示已生效（wall.js 含暂停文案）" \
  || bad "大屏 wall.js 是旧版（缺暂停提示）"

# 服务端文件不在 HTTP 上，只能查磁盘；它同时也是 bind mount 是否生效的判据
head2 '[4] 磁盘上的服务端代码'
if has_in_file "$SRC/server/state.js" newSession; then
  ok "server/state.js 含多节课逻辑（newSession）"
else
  bad "server/state.js 是旧版或路径不对：$SRC/server/state.js"
  info "确认解压目录：ls $SRC"
fi
if has_in_file "$SRC/server/index.js" 'bank:add'; then
  ok "server/index.js 含题库事件（bank:add）"
else
  bad "server/index.js 是旧版或路径不对"
fi
if command -v docker >/dev/null 2>&1 && docker inspect -f '{{.Mounts}}' "$CONTAINER" 2>/dev/null | grep -q 'server'; then
  ok "已配置源码 bind mount（改文件后只需 restart，不必重建镜像）"
else
  info "未检测到源码挂载：改代码后需要重新 docker build 才生效"
fi

# ---------------------------------------------------------------- 5. WebSocket
head2 '[5] WebSocket（弹幕 / 实时性的命门）'
if command -v curl >/dev/null 2>&1; then
  ws_url="$(printf '%s' "$BASE" | sed 's|^http|ws|')/socket.io/?EIO=4&transport=websocket"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$ws_url" 2>/dev/null)"
  if [ "$code" = "101" ]; then
    ok "WebSocket 握手成功（101 Switching Protocols）"
  else
    bad "WebSocket 没有升级（HTTP $code，期望 101）"
    info "反代（WAF / nginx）必须放行 Upgrade 头，否则会退化成长轮询，"
    info "弹幕和抢答会明显发飘。nginx 需要："
    info "  proxy_set_header Upgrade \$http_upgrade;"
    info "  proxy_set_header Connection \"upgrade\";"
  fi
fi

# ---------------------------------------------------------------- 汇总
printf '\n\033[1m%s\033[0m\n' '----------------------------------------'
if [ "$fail" -eq 0 ]; then
  printf '  \033[32m全部通过（%s 项）\033[0m\n' "$pass"
  printf '  下一步：打开 %s/c 创建课堂，用手机扫码走一遍。\n' "$BASE"
else
  printf '  \033[31m通过 %s 项，失败 %s 项\033[0m\n' "$pass" "$fail"
  printf '  按上面的提示逐条处理，处理完再跑一次本脚本。\n'
fi
printf '\n'

[ "$fail" -eq 0 ] || exit 1
