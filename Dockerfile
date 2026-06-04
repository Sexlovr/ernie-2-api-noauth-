FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data
ENV PORT=7860 DATA_DIR=/data
EXPOSE 7860
CMD ["node", "index.js"]
