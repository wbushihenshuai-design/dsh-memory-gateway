FROM node:20-alpine

WORKDIR /app

# 复制依赖和源代码
COPY package.json ./
COPY lib/ ./lib/
COPY gateway-server-next.js ./index.js

# 暴露端口
EXPOSE 8892

# 启动命令
CMD ["node", "index.js"]
