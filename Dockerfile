FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 仅拷贝依赖清单，充分利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝应用源码与示例数据
COPY server.js ./
COPY src ./src
COPY public ./public
COPY seed ./seed

# 数据目录（运行时可挂载卷持久化；首次启动自动写入示例数据）
ENV PORT=3000
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server.js"]
