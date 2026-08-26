# API com Playwright (Chromium)
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./

# Retries — Railway/Metal builder às vezes aborta o registry (ECONNRESET)
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && ( \
       npm ci \
    || (echo "npm ci falhou, tentando npm install..." && npm install) \
    || (echo "retry 1..." && sleep 10 && npm install) \
    || (echo "retry 2..." && sleep 20 && npm install) \
  )

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3333
ENV UPLOADS_DIR=/data/uploads

RUN mkdir -p tmp/downloads tmp/screenshots /data/uploads

EXPOSE 3333

CMD ["sh", "-c", "npx prisma db push && npx tsx src/index.ts"]
