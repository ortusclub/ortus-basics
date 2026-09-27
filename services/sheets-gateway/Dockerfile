FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY app.mjs server.mjs protocol.mjs ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
