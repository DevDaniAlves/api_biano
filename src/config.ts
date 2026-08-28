import "dotenv/config";
import { z } from "zod";

/** Railway às vezes grava o valor com aspas literais: "BianoWhats". */
function stripEnvQuotes(v: string | undefined) {
  if (v == null) return v;
  let t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

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
  /** evolution | meta | gupshup — transporte ativo de envio/recebimento. */
  WHATSAPP_PROVIDER: z.enum(["evolution", "meta", "gupshup"]).default("evolution"),
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
  /** Template Marketing aprovado: produto disponível (HEADER IMAGE + nome + produto). */
  META_PRODUTO_TEMPLATE_NAME: z.string().default("produto_disponivel"),
  /** Estimativa R$/msg faturável até rate card oficial set/2026. */
  META_ESTIMATED_BRL_PER_MSG: z.coerce.number().default(0.05),
  /** Key do Settings do app (console novo: BianoWhats → Settings). */
  GUPSHUP_API_KEY: z.string().optional().transform(stripEnvQuotes),
  GUPSHUP_API_BASE_URL: z.string().default("https://api.gupshup.io"),
  /** src.name do app no painel Gupshup. */
  GUPSHUP_APP_NAME: z.string().optional().transform(stripEnvQuotes),
  /** App ID (Settings), UUID. Apps FBC/Live usam v3 com este ID. */
  GUPSHUP_APP_ID: z.string().optional().transform(stripEnvQuotes),
  /** Número E.164 sem +, ex. 556634016000. */
  GUPSHUP_SOURCE: z.string().optional().transform(stripEnvQuotes),
  /** Header/query opcional no webhook (Gupshup não usa hub.verify da Meta). */
  GUPSHUP_WEBHOOK_SECRET: z.string().optional().transform(stripEnvQuotes),
  /** UUID do template Utility no painel Gupshup (espelho do boleto_lembrete). */
  GUPSHUP_BOLETO_TEMPLATE_ID: z.string().optional().transform(stripEnvQuotes),
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
  INACTIVITY_WARN_MINUTES: z.coerce.number().default(5),
  INACTIVITY_RESOLVE_MINUTES: z.coerce.number().default(10),
  /** Minutos sem msg do cliente no fluxo Financeiro → fecha e reinicia. 0 = off. Atendimento não auto-fecha. */
  CLIENT_IDLE_CLOSE_MINUTES: z.coerce.number().default(5),
  /** Horas sem mensagem (qualquer lado) para fechar a conversa sem enviar texto. */
  IDLE_CLOSE_HOURS: z.coerce.number().default(24),
  /** Chave Pix padrão (CNPJ) — sobrescrito pelo cadastro em Conectar WhatsApp. */
  PIX_KEY: z.string().optional(),
  PIX_KEY_TYPE: z.enum(["CPF", "CNPJ", "EMAIL", "PHONE", "EVP"]).default("CNPJ"),
  PIX_MERCHANT_NAME: z.string().default("Calangus Moda Jovem"),
  PIX_MESSAGE: z.string().optional(),
  /** native = order_details Meta | interactive = botões Opção 1 | auto = native → interactive */
  PIX_SEND_MODE: z.enum(["auto", "native", "interactive"]).default("interactive"),
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
