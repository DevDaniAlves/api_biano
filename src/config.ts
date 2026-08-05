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
  WHATSAPP_INSTANCE: z.string().optional(),
  /** Número comercial para wa.me (DDI+DDD+número). */
  WHATSAPP_BUSINESS_PHONE: z.string().optional(),
  /** Keyword no wa.me que pula menu departamento → vendedores. */
  CATALOG_WA_KEYWORD: z.string().default("catalogo"),
  /** wa_me | form — modo de contato no catálogo público. */
  CATALOG_CONTACT_MODE: z.enum(["wa_me", "form"]).default("wa_me"),
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
  JWT_SECRET: z.string().default("calangus-dev-secret-change-me"),
  API_PUBLIC_URL: z.string().default("http://localhost:3333"),
  RATING_TIMEOUT_MINUTES: z.coerce.number().default(5),
  INACTIVITY_WARN_MINUTES: z.coerce.number().default(10),
  INACTIVITY_RESOLVE_MINUTES: z.coerce.number().default(15),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:contato@calangusmodajovem.com"),
});

export const env = schema.parse(process.env);
