import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3333),
  DATABASE_URL: z.string().default("file:./dev.db"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  CREDIARIO_URL: z.string().default("https://login.meucrediario.com.br/"),
  CREDIARIO_USER: z.string().optional(),
  CREDIARIO_PASSWORD: z.string().optional(),
  CREDIARIO_REPORT_URL: z
    .string()
    .default("https://gestao.meucrediario.com.br/#!/relatorio/extratoparcelasabertas"),
  HEADLESS: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  WHATSAPP_API_URL: z.string().optional(),
  WHATSAPP_API_KEY: z.string().optional(),
  /** evolution | meta — transporte ativo de envio/recebimento. */
  WHATSAPP_PROVIDER: z.enum(["evolution", "meta"]).default("evolution"),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_WABA_ID: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  /** Config ID do Cadastro incorporado (Embedded Signup). */
  META_EMBEDDED_CONFIG_ID: z.string().optional(),
  /** Nome do template Utility aprovado para disparo de boletos. */
  META_BOLETO_TEMPLATE_NAME: z.string().optional(),
  META_BOLETO_TEMPLATE_LANG: z.string().default("pt_BR"),
  /** Estimativa R$/msg faturável até rate card oficial set/2026. */
  META_ESTIMATED_BRL_PER_MSG: z.coerce.number().default(0.05),
  /** Número comercial para wa.me (DDI+DDD+número). */
  WHATSAPP_BUSINESS_PHONE: z.string().optional(),
  /** Keyword no wa.me que pula menu departamento → vendedores. */
  CATALOG_WA_KEYWORD: z.string().default("catalogo"),
  /** wa_me | form — modo de contato no catálogo público. */
  CATALOG_CONTACT_MODE: z.enum(["wa_me", "form"]).default("wa_me"),
  /** URL pública da loja/catálogo (msg fora do horário). */
  CATALOG_PUBLIC_URL: z.string().default("https://webbiano-production.up.railway.app"),
  /** Se definido, ignora o telefone do Meu Crediário e envia só para este número (DDI+DDD). */
  WHATSAPP_OVERRIDE_PHONE: z.string().optional(),
  MESSAGE_TEMPLATE: z
    .string()
    .default(
      "Olá {{nome}}, tudo bem?\n\nPassando para lembrar que sua parcela de *R$ {{valor}}* vence em *{{vencimento}}*.\n\nPara consultar e pagar, acesse com CPF e data de nascimento:\n{{link}}\n\nCaso já tenha efetuado o pagamento, por favor desconsidere esta mensagem.\n\nCalangus Moda Jovem"
    ),
  CREDIARIO_CLIENTE_LINK: z
    .string()
    .default("http://calangusmoda.crediario.digital/login"),
  DISPATCH_DELAY_MS: z.coerce.number().default(2000),
  /** Delay “digitando…” antes do bot enviar (ms). Antes era 2–7s e gerava toque duplo no menu. */
  BOT_TYPING_DELAY_MS: z.coerce.number().default(400),
  JWT_SECRET: z.string().default("calangus-dev-secret-change-me"),
  API_PUBLIC_URL: z.string().default("http://localhost:3333"),
  /** Pasta persistente de mídia. No Railway, monte um Volume em /data e use /data/uploads. */
  UPLOADS_DIR: z.string().optional(),
  RATING_TIMEOUT_MINUTES: z.coerce.number().default(5),
  INACTIVITY_WARN_MINUTES: z.coerce.number().default(10),
  INACTIVITY_RESOLVE_MINUTES: z.coerce.number().default(15),
  /** Horas sem mensagem (qualquer lado) para fechar a conversa sem enviar texto. */
  IDLE_CLOSE_HOURS: z.coerce.number().default(24),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:contato@calangusmodajovem.com"),
  /** true = ignora horário comercial e escala (teste de notificações). */
  SKIP_BUSINESS_HOURS: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
});

export const env = schema.parse(process.env);
