FROM node:22-slim

# heif-convert (from libheif-examples) decodes HEIC/HEIF on Linux
RUN apt-get update && apt-get install -y libheif-examples && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000
ENV NODE_ENV=production

CMD ["npm", "start"]
