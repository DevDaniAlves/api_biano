-- NAO executado automaticamente. Revisar e aplicar manualmente.
CREATE TABLE IF NOT EXISTS "WhatsAppWebhookRoute" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "phoneNumberId" TEXT NOT NULL UNIQUE,
  "displayPhone" TEXT,
  "targetUrl" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "label" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- ATENCAO: a tabela criada pelo Prisma (migrate/db push) NAO tem DEFAULT em "id" nem
-- "updatedAt" (@default(uuid()) e @updatedAt sao aplicados pelo client, nao pelo banco).
-- Por isso o INSERT manual DEVE informar id e updatedAt:
--
-- INSERT INTO "WhatsAppWebhookRoute" ("id","phoneNumberId","displayPhone","targetUrl","active","label","createdAt","updatedAt")
-- VALUES (gen_random_uuid()::text,'<PHONE_NUMBER_ID>','<5511999999999>','https://<ref>.supabase.co/functions/v1/whatsapp',true,'Caristeo Healthcare',now(),now());
--
-- (createdAt tem DEFAULT now() no Prisma; informado aqui so por clareza.)
-- Se preferir poder omitir id/updatedAt, aplicar:
-- ALTER TABLE "WhatsAppWebhookRoute" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
-- ALTER TABLE "WhatsAppWebhookRoute" ALTER COLUMN "updatedAt" SET DEFAULT now();
