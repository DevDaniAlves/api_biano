# API com Playwright (Chromium)
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3333

RUN mkdir -p tmp/downloads tmp/screenshots uploads

EXPOSE 3333

CMD ["sh", "-c", "npx prisma db push && npx tsx src/index.ts"]
