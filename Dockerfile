FROM node:20-alpine

WORKDIR /app

# 仅先复制依赖清单，依赖安装随容器构建完成（利用 Docker 层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 复制应用源码
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# 容器启动即提供服务；首次运行时依赖已在镜像中就绪
CMD ["node", "server.js"]
