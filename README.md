# api_biano

API BIANO / Calangus — Express + Prisma + Playwright + WhatsApp (Evolution).

## Setup

```bash
copy .env.example .env
# preencha CREDIARIO_*, WhatsApp e JWT_SECRET

npm install
npx playwright install chromium
npm run db:generate
docker compose up -d db
npm run db:push
npm run db:seed
npm run dev
```

- API: http://localhost:3333  
- Swagger: http://localhost:3333/docs  

## Docker (API + Postgres)

```bash
docker compose up --build
```

Postgres no host: `postgresql://biano:biano@localhost:5433/biano`

## Front

Use o repositório **web_biano** com `VITE_API_URL` apontando para esta API.
