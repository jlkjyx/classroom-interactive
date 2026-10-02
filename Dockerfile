# 基础镜像地址可替换：国内服务器拉 Docker Hub 上的 node:22-alpine 常超时或失败。
# 优先在 Docker 守护进程配镜像加速（1Panel：容器 → 配置 → 镜像加速），配置好后
# 这里什么都不用改。只想临时绕一下时，构建时传参即可：
#   docker build --build-arg NODE_IMAGE=docker.1ms.run/library/node:22-alpine -t classroom-interactive:1.0.0 .
ARG NODE_IMAGE=node:22-alpine

# ---------- 构建阶段 ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# ---------- 运行阶段 ----------
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai

# 从构建阶段复制依赖
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY public ./public

# 数据持久化目录（房间快照）
RUN mkdir -p /app/data/rooms && chown -R node:node /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# node 22 自带全局 fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server/index.js"]
