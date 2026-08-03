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
  /** Se definido, ignora o telefone do Meu Crediário e envia só para este número (DDI+DDD). */
  WHATSAPP_OVERRIDE_PHONE: z.string().optional(),
  MESSAGE_TEMPLATE: z
    .string()
    .default(
      "Olá {{nome}}, sua parcela no valor de R$ {{valor}} vence em {{vencimento}}.\n\nAcesse com CPF e data de nascimento:\n{{link}}"
    ),
  CREDIARIO_CLIENTE_LINK: z
    .string()
    .default("http://calangusmoda.crediario.digital/login"),
  DISPATCH_DELAY_MS: z.coerce.number().default(2000),
  JWT_SECRET: z.string().default("calangus-dev-secret-change-me"),
  API_PUBLIC_URL: z.string().default("http://localhost:3333"),
});

export const env = schema.parse(process.env);
