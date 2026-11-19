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

-- Cadastro da rota (ajustar valores):
-- INSERT INTO "WhatsAppWebhookRoute" ("phoneNumberId","displayPhone","targetUrl","active","label")
-- VALUES ('<PHONE_NUMBER_ID>','<5511999999999>','https://<ref>.supabase.co/functions/v1/whatsapp',true,'Caristeo Healthcare');
