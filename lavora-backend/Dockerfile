FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY dashboard/ ./dashboard/

EXPOSE 3000

CMD ["node", "src/index.js"]
