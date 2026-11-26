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

## Rotas administrativas de repasse do webhook Meta (healthcare / delivery)

Router isolado: `src/routes/webhook-routes-admin.ts`, montado em `/integrations/webhook-routes` (uma linha em `src/index.ts`, antes do `express.json`). So le/escreve `WhatsAppWebhookRoute` (e le `WhatsAppConnection.metaPhoneNumberId` para a blocklist), apenas linhas com `source` em `caristeo-healthcare` ou `delivery-caristeo`. Linha sem `source` e interna: 409.

Sobre o fluxo interno: `POST /whatsapp/webhook/meta` NAO teve o roteamento alterado (ramos route > legacy > novo-saas iguais). Ha mudancas de log (`diagLog`, agora com ids de telefone mascarados) e o `findFirst` da rota passou a selecionar `active` e filtrar em memoria (resultado identico, pois `phoneNumberId` e unico). Em `meta-proxy.ts`, `forwardRawMetaWebhook` (rotas externas) usa `redirect: "manual"` e registra 3xx como erro; `forwardMetaWebhookToNewSaaS` nao foi tocada.

### Endpoints
- `POST /integrations/webhook-routes/connect` corpo `{phoneNumberId, displayPhone?, targetUrl, label?, source}`. Cria ou atualiza de forma atomica (create; em corrida/P2002, `updateMany` condicionado a `source` igual). 200 idempotente; outro dono: 409.
- `POST /integrations/webhook-routes/disconnect/:phoneNumberId` corpo `{phoneNumberId, source}` (o id e repetido no corpo assinado e deve igualar o da URL). Soft delete: `active=false`, `deletedAt`, `deletedBy`. Idempotente (`already_disconnected`, `absent`). POST em vez de DELETE para ter corpo assinado.
- Linha com soft delete so pode ser reconectada pelo MESMO source que a possuia (outro: 409).

### Autenticacao
- Segredo POR source: `WA_ROUTE_ADMIN_SECRET_CARISTEO_HEALTHCARE` e `WA_ROUTE_ADMIN_SECRET_DELIVERY_CARISTEO`, minimo 32 caracteres. O Biano le `source` do corpo assinado e valida a assinatura com o segredo daquele source; assim um sistema nao age sobre rota do outro. Segredo ausente/curto/igual ao do outro: 503 (falha fechada). `WA_ROUTE_ADMIN_SECRET` (unico) nao e mais usado.
- Cabecalhos `X-Route-Timestamp` (segundos) e `X-Route-Signature` = HMAC-SHA256 hex de `${timestamp}.${corpoBruto}`; janela de 5 min; comparacao em tempo constante. Source ausente/invalido ou assinatura errada: 401.
- Replay: a resposta de uma assinatura ja processada (por caminho+assinatura, ate 5000, 5 min) e devolvida do cache sem reexecutar.
- Corpo maximo 4KB (413).

### Seguranca do destino e dos numeros
- `targetUrl`: https, sem credenciais/porta/query, host nao-IP, path exato `/functions/v1/whatsapp`. `WA_ROUTE_ALLOWED_HOSTS` aceita SO hosts exatos (ex.: `refhealth.supabase.co,refdeliv.supabase.co`). Wildcard (`*`, `*.supabase.co`) ou entrada invalida: 503. Subdominios nao casam.
- Numeros internos nunca viram rota (403, em connect e disconnect): `META_PHONE_NUMBER_ID`, `WA_ROUTE_INTERNAL_PHONE_IDS` (csv), `1236714352864758` e `556634016000` (codigo) e todo `WhatsAppConnection.metaPhoneNumberId` do banco. Falha ao ler o banco: 500 (fecha).
- Allowlist opcional por source: `WA_ROUTE_ALLOWED_PHONE_IDS_CARISTEO_HEALTHCARE`, `WA_ROUTE_ALLOWED_PHONE_IDS_DELIVERY_CARISTEO` (csv). Se definida, so esses ids; se nao, qualquer id fora da blocklist.
- Rate limit: requisicoes autenticadas 30/min por `source|ip`. Falhas de autenticacao contam a parte (60/min por `ip|source`, com backoff exponencial ate 15 min; excedente 429) e NAO consomem o limite de quem assina corretamente. IP real: padrao = endereco do socket; atras de proxy defina `TRUST_PROXY=<n de saltos>` (usa o n-esimo `X-Forwarded-For` a partir da direita). So afeta estas rotas.
- Logs: so host, source e ids mascarados; nunca segredo nem URL completa.

### Variaveis de ambiente (Biano)
`WA_ROUTE_ADMIN_SECRET_CARISTEO_HEALTHCARE`, `WA_ROUTE_ADMIN_SECRET_DELIVERY_CARISTEO`, `WA_ROUTE_ALLOWED_HOSTS`, `WA_ROUTE_INTERNAL_PHONE_IDS` (opcional), `WA_ROUTE_ALLOWED_PHONE_IDS_CARISTEO_HEALTHCARE` / `WA_ROUTE_ALLOWED_PHONE_IDS_DELIVERY_CARISTEO` (opcionais), `TRUST_PROXY` (opcional). Ja existentes e usadas: `META_PHONE_NUMBER_ID`, `WA_DIAG_LOG`.

### Implantacao
1) SQL manual `prisma/migrations-manual/20261125_whatsapp_webhook_route_admin.sql`; 2) secrets; 3) deploy do Biano (`prisma generate`); 4) migrations + deploy do healthcare e do delivery. Linha ja existente criada a mao (ex.: healthcare 1278785958662616) so e gerenciada apos `UPDATE "WhatsAppWebhookRoute" SET "source"='caristeo-healthcare' WHERE "phoneNumberId"='<ID>' AND "source" IS NULL;`.
