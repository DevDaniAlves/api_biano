-- NAO executado automaticamente. Revisar e aplicar manualmente. Reexecutavel (idempotente).
-- Rotas admin CONECTAR/EXCLUIR: dono (source) e soft delete.
ALTER TABLE "WhatsAppWebhookRoute" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "WhatsAppWebhookRoute" ADD COLUMN IF NOT EXISTS "connectedAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppWebhookRoute" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppWebhookRoute" ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
-- Linhas existentes (criadas a mao) ficam com source NULL: a API as trata como "sem dono" e
-- responde 409 ao tentar conectar/excluir. Para a API passar a gerenciar uma delas:
-- UPDATE "WhatsAppWebhookRoute" SET "source"='caristeo-healthcare' WHERE "phoneNumberId"='<ID>';
