import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { env } from "../config.js";
import { prisma } from "../db.js";
import { authRequired, changePassword, createUser, login, userCanSeeAllMessages } from "../services/auth.js";
import {
  ensureFlow,
  getFlow,
  restartToBot,
  setWebhookPaused,
  setCrmBotEnabled,
  isCrmBotEnabled,
  type FlowOption,
} from "../services/whatsapp/flow.js";
import {
  recordWebhookHit,
  webhookStatusPayload,
} from "../services/whatsapp/webhook-hits.js";
import { evolution, EvolutionClient } from "../services/whatsapp/evolution.js";
import { activeProvider } from "../services/whatsapp/gateway.js";
import { meta } from "../services/whatsapp/meta.js";
import { getWhatsAppUsage, handleMetaWebhook } from "../services/whatsapp/meta-webhook.js";
import { gupshup } from "../services/whatsapp/gupshup.js";
import { handleGupshupWebhook } from "../services/whatsapp/gupshup-webhook.js";
import { parseGupshupEnvelope, unwrapGupshupBodies } from "../services/whatsapp/gupshup-mapper.js";
import {
  deletePushSubscription,
  getVapidPublicKey,
  pendingBadgeCount,
  savePushSubscription,
} from "../services/push.js";
import {
  UPLOADS_DIR,
  assignContact,
  contactFlags,
  getWhatsAppReports,
  handleEvolutionWebhook,
  listContacts,
  openContactToAllSellers,
  saveContactName,
  listMessages,
  resolveContact,
  seedDemoReports,
  sendImageMessage,
  sendImageMessagesConcurrent,
  sendProductOutreach,
  sendTextMessage,
  warnInactivity,
} from "../services/whatsapp/service.js";
import { serializeContact } from "../services/whatsapp/contacts.js";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const fromName = path.extname(file.originalname);
      const mime = file.mimetype || "";
      const fromMime = mime.includes("webm")
        ? ".webm"
        : mime.includes("ogg")
          ? ".ogg"
          : mime.includes("mp4") || mime.includes("quicktime")
            ? ".mp4"
            : mime.includes("mpeg") || mime.includes("mp3")
              ? ".mp3"
              : mime.startsWith("audio/")
                ? ".ogg"
                : mime.startsWith("video/")
                  ? ".mp4"
                  : mime.startsWith("image/")
                    ? ".jpg"
                    : mime.includes("pdf")
                      ? ".pdf"
                      : "";
      const ext = fromName || fromMime || ".bin";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("audio/") ||
      file.mimetype.startsWith("video/") ||
      file.mimetype === "application/pdf" ||
      file.mimetype.includes("word") ||
      file.mimetype.includes("excel") ||
      file.mimetype.includes("spreadsheet") ||
      file.mimetype.includes("officedocument");
    if (ok) cb(null, true);
    else cb(new Error("Tipo de arquivo não suportado"));
  },
});

export const whatsappRouter = Router();

whatsappRouter.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "");
    const password = String(req.body?.password ?? "");
    const result = await login(email, password);
    if (!result) {
      res.status(401).json({ error: "E-mail ou senha inválidos" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/auth/me", authRequired, async (req, res) => {
  const row = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      seeAllMessages: true,
      showInAttendantList: true,
      flowAtendimento: true,
      flowFinanceiro: true,
      canManageCatalog: true,
    },
  });
  if (!row?.active) {
    res.status(401).json({ error: "Usuário inativo" });
    return;
  }
  res.json({
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      seeAllMessages: Boolean(row.seeAllMessages),
      showInAttendantList: row.showInAttendantList !== false,
      flowAtendimento: row.flowAtendimento !== false,
      flowFinanceiro: Boolean(row.flowFinanceiro),
      canManageCatalog: row.role === "admin" || Boolean(row.canManageCatalog),
    },
  });
});

whatsappRouter.post("/webhook/evolution", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const key = (data.key ?? {}) as Record<string, unknown>;
    const message = (data.message ?? {}) as Record<string, unknown>;
    const preview =
      typeof message.conversation === "string"
        ? message.conversation
        : message.extendedTextMessage && typeof message.extendedTextMessage === "object"
          ? String((message.extendedTextMessage as { text?: string }).text ?? "")
          : null;
    recordWebhookHit({
      path: "/whatsapp/webhook/evolution",
      method: "POST",
      ip: req.ip,
      event: String(body.event ?? body.type ?? "MESSAGES_UPSERT"),
      from: key.remoteJid ? String(key.remoteJid) : null,
      preview,
    });
    // ACK imediato — Evolution não espera o bot terminar (evita fila/atraso).
    res.json({ ok: true });
    void handleEvolutionWebhook(body).catch((err) => console.error("[webhook]", err));
  } catch (err) {
    console.error("[webhook]", err);
    if (!res.headersSent) res.json({ ok: true });
  }
});

whatsappRouter.get("/webhook/status", (_req, res) => {
  res.json(webhookStatusPayload());
});

/** Meta Cloud API — verificação do webhook. */
whatsappRouter.get("/webhook/meta", (req, res) => {
  const mode = String(req.query["hub.mode"] ?? "");
  const token = String(req.query["hub.verify_token"] ?? "");
  const challenge = String(req.query["hub.challenge"] ?? "");
  const expected = (env.META_WEBHOOK_VERIFY_TOKEN || "").trim();
  if (mode === "subscribe" && expected && token === expected) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

whatsappRouter.post("/webhook/meta", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const entry0 = Array.isArray(body.entry) ? (body.entry[0] as Record<string, unknown>) : null;
    const change0 =
      entry0 && Array.isArray(entry0.changes)
        ? (entry0.changes[0] as { value?: Record<string, unknown> })
        : null;
    const value = change0?.value ?? {};
    const msg0 = Array.isArray(value.messages)
      ? (value.messages[0] as Record<string, unknown>)
      : null;
    const st0 = Array.isArray(value.statuses)
      ? (value.statuses[0] as Record<string, unknown>)
      : null;
    const from = msg0
      ? String(msg0.from ?? "")
      : st0
        ? String(st0.recipient_id ?? "")
        : null;
    const preview = msg0
      ? msg0.text && typeof msg0.text === "object"
        ? String((msg0.text as { body?: string }).body ?? `[${String(msg0.type ?? "msg")}]`)
        : `[${String(msg0.type ?? "msg")}]`
      : st0
        ? `status=${String(st0.status ?? "")}`
        : null;
    recordWebhookHit({
      path: "/whatsapp/webhook/meta",
      method: "POST",
      ip: req.ip,
      event: msg0 ? "messages" : st0 ? "statuses" : String(body.object ?? "whatsapp_business_account"),
      from: from || null,
      preview,
    });
    res.sendStatus(200);
    void handleMetaWebhook(body).catch((err) => console.error("[webhook/meta]", err));
  } catch (err) {
    console.error("[webhook/meta]", err);
    if (!res.headersSent) res.sendStatus(200);
  }
});

whatsappRouter.get("/webhook/gupshup", (req, res) => {
  const expected = (env.GUPSHUP_WEBHOOK_SECRET || "").trim();
  if (expected) {
    const given = String(req.query.secret ?? req.query.token ?? "").trim();
    if (given && given !== expected) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
  }
  res.json({ ok: true });
});

whatsappRouter.post("/webhook/gupshup", async (req, res) => {
  try {
    const envelopes = unwrapGupshupBodies(req.body);
    const first = envelopes[0] ? parseGupshupEnvelope(envelopes[0]) : null;
    recordWebhookHit({
      path: "/whatsapp/webhook/gupshup",
      method: "POST",
      ip: req.ip,
      event: first?.envelopeType || "gupshup",
      from: first?.phone || null,
      preview: first?.body || first?.status || null,
    });
    res.json({ ok: true });
    void handleGupshupWebhook(req.body).catch((err) => console.error("[webhook/gupshup]", err));
  } catch (err) {
    console.error("[webhook/gupshup]", err);
    if (!res.headersSent) res.json({ ok: true });
  }
});

/**
 * Redirect URI do Cadastro incorporado hospedado pela Meta (OAuth).
 * Colar na Meta: {API_PUBLIC_URL}/whatsapp/meta/embedded-signup
 */
whatsappRouter.get("/meta/embedded-signup", (req, res) => {
  const q = req.query as Record<string, unknown>;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v == null) continue;
    params[k] = Array.isArray(v) ? v.map(String).join(",") : String(v);
  }

  console.log("[meta/embedded-signup] callback", params);

  const error = params.error || params.error_message || "";
  const code = params.code || "";
  const state = params.state || "";
  const wantsJson =
    req.query.format === "json" ||
    String(req.headers.accept || "").includes("application/json");

  if (wantsJson) {
    res.json({
      ok: !error,
      error: error || null,
      code: code || null,
      state: state || null,
      params,
      hint: "Troque o code por access_token via Graph API (client_id + client_secret).",
    });
    return;
  }

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const rows = Object.entries(params)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(v)}</code></td></tr>`)
    .join("");

  res.type("html").send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meta Embedded Signup — BIANO</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    .ok { color: #0a7; } .err { color: #c00; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
    th { width: 30%; color: #555; }
    code { word-break: break-all; font-size: 0.85rem; }
    .box { background: #f6f6f6; padding: 1rem; border-radius: 8px; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1 class="${error ? "err" : "ok"}">${error ? "Cadastro incompleto / erro" : "Cadastro incorporado — retorno OK"}</h1>
  <p>Callback do <strong>Cadastro incorporado hospedado pela Meta</strong> no BIANO.</p>
  ${
    error
      ? `<div class="box err"><strong>Erro:</strong> ${esc(error)}</div>`
      : code
        ? `<div class="box ok"><strong>Code recebido.</strong> Guarde este retorno e use no exchange do token (Graph API).</div>`
        : `<div class="box">Nenhum <code>code</code> na URL. Se o fluxo Meta terminou, confira se o redirect URI está idêntico ao cadastrado.</div>`
  }
  <table>
    <tbody>
      ${rows || "<tr><td colspan='2'>Sem query params</td></tr>"}
    </tbody>
  </table>
  <p style="margin-top:1.5rem;color:#666;font-size:0.9rem">URL desta rota: <code>/whatsapp/meta/embedded-signup</code></p>
</body>
</html>`);
});

whatsappRouter.use(authRequired);

function webPublicOrigin() {
  const origins = env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  const https = origins.find((o) => o.startsWith("https://"));
  return https || origins[0] || "http://localhost:5173";
}

function buildEmbeddedSignupUrl() {
  const appId = (env.META_APP_ID || "").trim();
  const configId = (env.META_EMBEDDED_CONFIG_ID || "").trim();
  if (!appId || !configId) return null;
  const redirect = `${webPublicOrigin().replace(/\/+$/, "")}/whatsapp/meta/callback`;
  const extras = encodeURIComponent(
    JSON.stringify({
      version: "v4",
      sessionInfoVersion: "3",
      featureType: "whatsapp_business_app_onboarding",
    })
  );
  return `https://business.facebook.com/messaging/whatsapp/onboard/?app_id=${encodeURIComponent(appId)}&config_id=${encodeURIComponent(configId)}&extras=${extras}&redirect_uri=${encodeURIComponent(redirect)}`;
}

whatsappRouter.get("/meta/status", async (_req, res) => {
  try {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    const provider = await activeProvider();
    const phoneNumberId =
      (row?.metaPhoneNumberId || "").trim() || (env.META_PHONE_NUMBER_ID || "").trim() || null;
    const wabaId = (row?.metaWabaId || "").trim() || (env.META_WABA_ID || "").trim() || null;
    res.json({
      provider,
      configured: Boolean(env.META_ACCESS_TOKEN && phoneNumberId),
      hasAccessToken: Boolean(env.META_ACCESS_TOKEN),
      phoneNumberId,
      wabaId,
      appId: env.META_APP_ID || null,
      embeddedConfigId: env.META_EMBEDDED_CONFIG_ID || null,
      embeddedSignupUrl: buildEmbeddedSignupUrl(),
      webhookPath: "/whatsapp/webhook/meta",
      webhookUrl: `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/whatsapp/webhook/meta`,
      webhookVerifyTokenSet: Boolean((env.META_WEBHOOK_VERIFY_TOKEN || "").trim()),
      boletoTemplate: env.META_BOLETO_TEMPLATE_NAME || null,
      boletoTemplateLang: env.META_BOLETO_TEMPLATE_LANG || "pt_BR",
      botEnabled: row?.botEnabled !== false,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/gupshup/status", async (_req, res) => {
  try {
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    const provider = await activeProvider();
    const creds = await gupshup.credentials();
    const webhookUrl = `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/whatsapp/webhook/gupshup`;
    res.json({
      provider,
      configured: Boolean(creds.apiKey && creds.source && (creds.appId || creds.appName)),
      buttonsEnabled: Boolean(creds.appId),
      appName: creds.appName || null,
      appId: creds.appId || null,
      source: creds.source || null,
      wabaId: (row?.gupshupWabaId || "").trim() || null,
      coexistenceEnabled: Boolean(row?.coexistenceEnabled),
      connectedAt: row?.connectedAt ?? null,
      webhookPath: "/whatsapp/webhook/gupshup",
      webhookUrl,
      boletoTemplateId: (env.GUPSHUP_BOLETO_TEMPLATE_ID || "").trim() || null,
      webhookSecretSet: Boolean((env.GUPSHUP_WEBHOOK_SECRET || "").trim()),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/gupshup/settings", async (req, res) => {
  try {
    const appId = String(req.body?.appId ?? "").trim();
    if (!appId) {
      res.status(400).json({ error: "App ID obrigatório (Settings do app Gupshup)" });
      return;
    }
    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      create: { id: "default", gupshupAppId: appId },
      update: { gupshupAppId: appId },
    });
    res.json({ ok: true, appId: row.gupshupAppId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const DEFAULT_BOLETO_BODY =
  "Olá {{1}}, tudo bem?\n\nPassando para lembrar que sua parcela de R$ {{2}} vence em {{3}}.\n\nPara consultar e pagar, acesse o link a seguir e entre com CPF e data de nascimento:\n{{4}}\n\nCaso já tenha efetuado o pagamento, por favor desconsidere esta mensagem.\n\nAtenciosamente,\nCalangus Moda Jovem";

/** Marketing: avisar cliente que o produto de interesse chegou. HEADER = IMAGE (foto). */
const DEFAULT_PRODUTO_BODY =
  "Olá {{1}}! Tudo bem?\n\nBoa notícia: o produto que você demonstrou interesse chegou na Calangus.\n\n📦 {{2}}\n\nSe quiser garantir o seu, responda esta mensagem que a gente te atende por aqui.\n\nCalangus Moda Jovem";

const DEFAULT_PRODUTO_EXAMPLES = ["Maria Silva", "Vestido Floral M"];

whatsappRouter.post("/meta/settings", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const phoneNumberId = String(req.body?.phoneNumberId ?? "").trim();
    const wabaId = String(req.body?.wabaId ?? "").trim();
    if (!phoneNumberId && !wabaId) {
      res.status(400).json({ error: "Informe phoneNumberId e/ou wabaId" });
      return;
    }
    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        ...(phoneNumberId ? { metaPhoneNumberId: phoneNumberId } : {}),
        ...(wabaId ? { metaWabaId: wabaId } : {}),
      },
      update: {
        ...(phoneNumberId ? { metaPhoneNumberId: phoneNumberId } : {}),
        ...(wabaId ? { metaWabaId: wabaId } : {}),
      },
    });
    res.json({
      ok: true,
      phoneNumberId: row.metaPhoneNumberId,
      wabaId: row.metaWabaId,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/meta/profile", async (_req, res) => {
  try {
    if (!meta.enabled) {
      res.status(400).json({ error: "Meta não configurada (META_ACCESS_TOKEN)" });
      return;
    }
    const [profileR, phoneR] = await Promise.all([
      meta.getBusinessProfile(),
      meta.getPhoneNumberInfo(),
    ]);
    if (!profileR.ok && profileR.status) {
      res.status(profileR.status).json({
        error: profileR.text.slice(0, 500),
        profile: null,
        phone: phoneR.info,
      });
      return;
    }
    res.json({
      profile: profileR.profile,
      phone: phoneR.info,
      managerUrl:
        "https://business.facebook.com/latest/whatsapp_manager/phone_numbers/?tab=phone-numbers",
      note:
        "Nome de exibição e horário de funcionamento só no WhatsApp Manager. Via API: foto, sobre, descrição, e-mail, endereço, categoria e sites.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/meta/profile", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    if (!meta.enabled) {
      res.status(400).json({ error: "Meta não configurada" });
      return;
    }
    const websitesRaw = req.body?.websites;
    const websites = Array.isArray(websitesRaw)
      ? websitesRaw.map((w: unknown) => String(w).trim()).filter(Boolean)
      : typeof websitesRaw === "string"
        ? websitesRaw
            .split(/[\n,]/)
            .map((w) => w.trim())
            .filter(Boolean)
        : undefined;

    const r = await meta.updateBusinessProfile({
      about: req.body?.about != null ? String(req.body.about) : undefined,
      address: req.body?.address != null ? String(req.body.address) : undefined,
      description: req.body?.description != null ? String(req.body.description) : undefined,
      email: req.body?.email != null ? String(req.body.email) : undefined,
      vertical: req.body?.vertical != null ? String(req.body.vertical) : undefined,
      websites,
    });
    if (!r.ok) {
      res.status(r.status || 400).json({ error: r.text.slice(0, 500) });
      return;
    }
    const refreshed = await meta.getBusinessProfile();
    res.json({ ok: true, profile: refreshed.profile });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/meta/profile/picture", upload.single("file"), async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    if (!meta.enabled) {
      res.status(400).json({ error: "Meta não configurada" });
      return;
    }
    const file = req.file;
    if (!file?.buffer && !file?.path) {
      res.status(400).json({ error: "Envie a imagem no campo file" });
      return;
    }
    const buf = file.buffer
      ? Buffer.from(file.buffer)
      : fs.readFileSync(file.path);
    const mime = file.mimetype || "image/jpeg";
    if (!mime.startsWith("image/")) {
      res.status(400).json({ error: "Arquivo precisa ser imagem" });
      return;
    }
    const up = await meta.uploadProfilePicture(buf, mime, file.originalname || "profile.jpg");
    if (!up.ok || !up.handle) {
      res.status(up.status || 400).json({ error: up.text || "Falha no upload" });
      return;
    }
    const upd = await meta.updateBusinessProfile({ profilePictureHandle: up.handle });
    if (!upd.ok) {
      res.status(upd.status || 400).json({ error: upd.text.slice(0, 500) });
      return;
    }
    const refreshed = await meta.getBusinessProfile();
    res.json({ ok: true, profile: refreshed.profile });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/meta/templates", async (_req, res) => {
  try {
    if (!meta.enabled) {
      res.status(400).json({ error: "Meta não configurada" });
      return;
    }
    const r = await meta.listMessageTemplates();
    if (!r.ok) {
      res.status(r.status || 400).json({ error: r.text.slice(0, 500), templates: [] });
      return;
    }
    res.json({
      templates: r.templates,
      defaultBoleto: {
        name: env.META_BOLETO_TEMPLATE_NAME || "boleto_lembrete",
        language: env.META_BOLETO_TEMPLATE_LANG || "pt_BR",
        category: "UTILITY",
        bodyText: DEFAULT_BOLETO_BODY,
        bodyExamples: ["Maria", "129,90", "20/08/2026", "https://calangusmoda.crediario.digital/login"],
        headerFormat: null,
      },
      defaultProduto: {
        name: "produto_disponivel",
        language: env.META_BOLETO_TEMPLATE_LANG || "pt_BR",
        category: "MARKETING",
        bodyText: DEFAULT_PRODUTO_BODY,
        bodyExamples: DEFAULT_PRODUTO_EXAMPLES,
        headerFormat: "IMAGE",
        vars: [
          { n: 1, label: "Nome do cliente" },
          { n: 2, label: "Nome do produto" },
        ],
        note: "A foto do produto vai no HEADER (IMAGE) no envio — não é variável do texto.",
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post(
  "/meta/templates",
  (req, res, next) => {
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("multipart/form-data")) {
      upload.single("file")(req, res, next);
      return;
    }
    next();
  },
  async (req, res) => {
  try {
    if (!meta.enabled) {
      res.status(400).json({ error: "Meta não configurada" });
      return;
    }
    const name = String(req.body?.name ?? "").trim();
    const bodyText = String(req.body?.bodyText ?? "").trim();
    const language = String(req.body?.language ?? env.META_BOLETO_TEMPLATE_LANG ?? "pt_BR").trim();
    const category = String(req.body?.category ?? "UTILITY").trim().toUpperCase() as
      | "UTILITY"
      | "MARKETING"
      | "AUTHENTICATION";
    const replaceExisting =
      req.body?.replaceExisting === true ||
      req.body?.replaceExisting === "true" ||
      req.body?.replaceExisting === "1";
    let bodyExamples: string[] = [];
    if (Array.isArray(req.body?.bodyExamples)) {
      bodyExamples = (req.body.bodyExamples as unknown[])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean);
    } else if (typeof req.body?.bodyExamples === "string" && req.body.bodyExamples.trim()) {
      try {
        const parsed = JSON.parse(req.body.bodyExamples) as unknown;
        if (Array.isArray(parsed)) {
          bodyExamples = parsed.map((x) => String(x ?? "").trim()).filter(Boolean);
        }
      } catch {
        bodyExamples = String(req.body.bodyExamples)
          .split("|")
          .map((x: string) => x.trim())
          .filter(Boolean);
      }
    }
    const headerFormat =
      String(req.body?.headerFormat ?? "").trim().toUpperCase() === "IMAGE" ? "IMAGE" : null;
    let headerHandle = String(req.body?.headerHandle ?? "").trim() || null;
    const headerSampleUrl = String(req.body?.headerSampleUrl ?? "").trim();
    if (!name || !bodyText) {
      res.status(400).json({ error: "name e bodyText obrigatórios" });
      return;
    }
    if (headerFormat === "IMAGE" && !headerHandle && req.file) {
      const buf = fs.readFileSync(req.file.path);
      const up = await meta.uploadTemplateHeaderHandle({
        buffer: buf,
        mimeType: req.file.mimetype || "image/jpeg",
        fileName: req.file.originalname || "template_sample.jpg",
      });
      if (!up.ok) {
        res.status(up.status || 400).json({ error: up.text.slice(0, 800) });
        return;
      }
      headerHandle = up.handle;
    }
    if (headerFormat === "IMAGE" && !headerHandle && headerSampleUrl) {
      if (!/^https:\/\//i.test(headerSampleUrl)) {
        res.status(400).json({ error: "headerSampleUrl deve ser HTTPS público" });
        return;
      }
      const imgRes = await fetch(headerSampleUrl);
      if (!imgRes.ok) {
        res.status(400).json({ error: `Não baixou a imagem de exemplo (${imgRes.status})` });
        return;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mime =
        imgRes.headers.get("content-type")?.split(";")[0].trim() ||
        (headerSampleUrl.toLowerCase().includes(".png") ? "image/png" : "image/jpeg");
      const up = await meta.uploadTemplateHeaderHandle({
        buffer: buf,
        mimeType: mime,
        fileName: "template_sample.jpg",
      });
      if (!up.ok) {
        res.status(up.status || 400).json({ error: up.text.slice(0, 800) });
        return;
      }
      headerHandle = up.handle;
    }
    if (replaceExisting) {
      const del = await meta.deleteMessageTemplate(name);
      if (!del.ok && del.status !== 404) {
        // segue mesmo se não existir; só aborta em erro grave inesperado
        const msg = del.text.toLowerCase();
        if (!msg.includes("does not exist") && !msg.includes("not found")) {
          console.warn("[meta] delete template before recreate", del.status, del.text.slice(0, 200));
        }
      }
    }
    const r = await meta.createMessageTemplate({
      name,
      language,
      category:
        category === "MARKETING" || category === "AUTHENTICATION" ? category : "UTILITY",
      bodyText,
      bodyExamples,
      headerFormat,
      headerHandle,
    });
    if (!r.ok) {
      res.status(r.status || 400).json({ error: r.text.slice(0, 800), data: r.data });
      return;
    }
    res.json({ ok: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/meta/templates/:name", async (req, res) => {
  try {
    if (!meta.enabled) {
      res.status(400).json({ error: "Meta não configurada" });
      return;
    }
    const name = String(req.params.name ?? "").trim();
    const r = await meta.deleteMessageTemplate(name);
    if (!r.ok) {
      res.status(r.status || 400).json({ error: r.text.slice(0, 500), data: r.data });
      return;
    }
    res.json({ ok: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function setWhatsAppProvider(req: Request, res: Response) {
  try {
    const provider = String(req.body?.provider ?? "").trim().toLowerCase();
    if (provider !== "meta" && provider !== "evolution" && provider !== "gupshup") {
      res.status(400).json({ error: "provider deve ser meta, evolution ou gupshup" });
      return;
    }
    if (provider === "meta" && !env.META_ACCESS_TOKEN) {
      res.status(400).json({
        error: "Meta não configurada (META_ACCESS_TOKEN no .env)",
      });
      return;
    }
    if (provider === "gupshup" && !(await gupshup.isConfigured())) {
      res.status(400).json({
        error: "Gupshup não configurada (GUPSHUP_API_KEY, GUPSHUP_APP_NAME, GUPSHUP_SOURCE no .env)",
      });
      return;
    }
    const creds = provider === "gupshup" ? await gupshup.credentials() : null;
    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        provider,
        ...(creds
          ? {
              gupshupAppName: creds.appName,
              gupshupSource: creds.source,
              ...(creds.appId ? { gupshupAppId: creds.appId } : {}),
              coexistenceEnabled: true,
              connectedAt: new Date(),
            }
          : {}),
      },
      update: {
        provider,
        ...(creds
          ? {
              gupshupAppName: creds.appName,
              gupshupSource: creds.source,
              ...(creds.appId ? { gupshupAppId: creds.appId } : {}),
              coexistenceEnabled: true,
              connectedAt: new Date(),
            }
          : {}),
      },
    });
    res.json({ ok: true, provider: row.provider });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

whatsappRouter.post("/meta/provider", setWhatsAppProvider);
whatsappRouter.post("/provider", setWhatsAppProvider);

whatsappRouter.post("/bot", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "Informe enabled: true|false" });
      return;
    }
    const row = await setCrmBotEnabled(req.body.enabled);
    res.json({ ok: true, botEnabled: row.botEnabled });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/bot", async (_req, res) => {
  try {
    res.json({ botEnabled: await isCrmBotEnabled() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/meta/exchange", async (req, res) => {
  try {
    const code = String(req.body?.code ?? "").trim();
    if (!code) {
      res.status(400).json({ error: "code obrigatório" });
      return;
    }
    const phoneNumberId = req.body?.phoneNumberId
      ? String(req.body.phoneNumberId).trim()
      : "";
    const wabaId = req.body?.wabaId ? String(req.body.wabaId).trim() : "";

    const exchanged = await meta.exchangeCode(code);
    if (phoneNumberId || wabaId) {
      await prisma.whatsAppConnection.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          metaPhoneNumberId: phoneNumberId || null,
          metaWabaId: wabaId || null,
        },
        update: {
          ...(phoneNumberId ? { metaPhoneNumberId: phoneNumberId } : {}),
          ...(wabaId ? { metaWabaId: wabaId } : {}),
        },
      });
    }

    if (!exchanged.ok) {
      res.status(400).json({
        ok: false,
        error: exchanged.error,
        savedIds: Boolean(phoneNumberId || wabaId),
        hint: "Token permanente: use Usuário do sistema no Business Manager e cole META_ACCESS_TOKEN no .env",
      });
      return;
    }

    res.json({
      ok: true,
      accessTokenReceived: Boolean(exchanged.accessToken),
      savedIds: Boolean(phoneNumberId || wabaId),
      hint: exchanged.accessToken
        ? "Cole o access_token em META_ACCESS_TOKEN no .env (ou use token de system user)."
        : "Code trocado; confirme o token no .env.",
      // Não devolvemos o token completo na resposta por segurança em logs de proxy —
      // mas o admin precisa ver. Prefixo curto:
      tokenPreview: exchanged.accessToken
        ? `${exchanged.accessToken.slice(0, 12)}…`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/usage", async (req, res) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const data = await getWhatsAppUsage({
      from: from && !Number.isNaN(from.getTime()) ? from : undefined,
      to: to && !Number.isNaN(to.getTime()) ? to : undefined,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/push/vapid-public", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({ error: "Push não configurado (VAPID)" });
    return;
  }
  res.json({ publicKey: key });
});

whatsappRouter.post("/push/subscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint ?? "");
    const p256dh = String(req.body?.keys?.p256dh ?? req.body?.p256dh ?? "");
    const auth = String(req.body?.keys?.auth ?? req.body?.auth ?? "");
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: "Subscription inválida" });
      return;
    }
    await savePushSubscription({
      userId: req.user!.id,
      endpoint,
      p256dh,
      auth,
      userAgent: req.get("user-agent"),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/push/badge", async (req, res) => {
  try {
    const count = await pendingBadgeCount(req.user!.id, req.user!.role);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/push/subscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint ?? req.query.endpoint ?? "");
    if (!endpoint) {
      res.status(400).json({ error: "endpoint obrigatório" });
      return;
    }
    await deletePushSubscription(endpoint, req.user!.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/auth/password", async (req, res) => {
  try {
    await changePassword({
      userId: req.user!.id,
      currentPassword: String(req.body?.currentPassword ?? ""),
      newPassword: String(req.body?.newPassword ?? ""),
    });
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      message.includes("incorreta") ||
      message.includes("diferente") ||
      message.includes("6 caracteres")
        ? 400
        : 500;
    res.status(code).json({ error: message });
  }
});

whatsappRouter.get("/contacts", async (req, res) => {
  try {
    const contacts = await listContacts({
      userId: req.user!.id,
      role: req.user!.role,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      sellerId:
        (await userCanSeeAllMessages(req.user!.id, req.user!.role)) &&
        typeof req.query.sellerId === "string"
          ? req.query.sellerId
          : undefined,
    });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/messages", async (req, res) => {
  try {
    const contactId = String(req.query.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    const peek = req.query.peek === "1" || req.query.peek === "true";
    res.json(
      await listMessages(contactId, req.user!.id, req.user!.role as "admin" | "seller", {
        assume: !peek,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const forbidden =
      msg.includes("assumida") || msg.includes("oferecida a outro");
    res.status(forbidden ? 403 : 500).json({ error: msg });
  }
});

whatsappRouter.post("/messages", async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "");
    const body = String(req.body?.body ?? "").trim();
    if (!contactId || !body) {
      res.status(400).json({ error: "contactId e body obrigatórios" });
      return;
    }
    const msg = await sendTextMessage({
      contactId,
      body,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
      quotedMessageId: req.body?.quotedMessageId
        ? String(req.body.quotedMessageId)
        : null,
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function mediaKind(mimetype: string): "image" | "audio" | "video" | "document" {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "audio";
  if (mimetype.startsWith("video/")) return "video";
  return "document";
}

whatsappRouter.post("/messages/image", upload.single("file"), async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId || !req.file) {
      res.status(400).json({ error: "contactId e file obrigatórios" });
      return;
    }
    const publicUrl = `/uploads/${req.file.filename}`;
    const clientKey = String(req.body?.clientKey ?? "").trim() || undefined;
    const msg = await sendImageMessage({
      contactId,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
      filePath: req.file.path,
      mimetype: req.file.mimetype,
      fileName: req.file.originalname,
      caption: req.body?.caption ? String(req.body.caption) : undefined,
      publicUrl,
      mediatype: mediaKind(req.file.mimetype),
      clientKey,
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Multi-foto concorrente (sem fila): upload N arquivos → envios paralelos à Meta. */
whatsappRouter.post("/messages/images", upload.array("files", 12), async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "").trim();
    const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
    if (!contactId || files.length === 0) {
      res.status(400).json({ error: "contactId e files obrigatórios" });
      return;
    }
    const caption = req.body?.caption ? String(req.body.caption).trim() : "";
    const rawKeys = req.body?.clientKeys;
    let clientKeys: string[] = [];
    if (Array.isArray(rawKeys)) {
      clientKeys = rawKeys.map((k) => String(k ?? ""));
    } else if (typeof rawKeys === "string" && rawKeys.trim()) {
      try {
        const parsed = JSON.parse(rawKeys) as unknown;
        clientKeys = Array.isArray(parsed) ? parsed.map((k) => String(k ?? "")) : [rawKeys];
      } catch {
        clientKeys = [rawKeys];
      }
    }

    const results = await sendImageMessagesConcurrent({
      contactId,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
      items: files.map((file, i) => ({
        filePath: file.path,
        mimetype: file.mimetype,
        fileName: file.originalname,
        publicUrl: `/uploads/${file.filename}`,
        caption: i === 0 && caption ? caption : undefined,
        clientKey: clientKeys[i] || undefined,
      })),
    });

    const failed = results.filter((r) => !r.ok);
    res.status(failed.length && failed.length === results.length ? 500 : 200).json({
      results,
      messages: results.filter((r) => r.ok).map((r) => r.message),
      errors: failed.map((r) => ({
        index: r.index,
        clientKey: r.clientKey,
        error: r.error,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Template Marketing: avisar cliente que o produto chegou (foto + nome). */
whatsappRouter.post("/messages/product-outreach", upload.single("file"), async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "").trim();
    const productName = String(req.body?.productName ?? "").trim();
    if (!contactId || !productName || !req.file) {
      res.status(400).json({ error: "contactId, productName e foto obrigatórios" });
      return;
    }
    if (!req.file.mimetype.startsWith("image/")) {
      res.status(400).json({ error: "Envie uma imagem (JPG/PNG)" });
      return;
    }
    const publicUrl = `/uploads/${req.file.filename}`;
    const msg = await sendProductOutreach({
      contactId,
      productName,
      userId: req.user!.id,
      role: req.user!.role as "admin" | "seller",
      filePath: req.file.path,
      mimetype: req.file.mimetype,
      fileName: req.file.originalname,
      publicUrl,
    });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/assign", async (req, res) => {
  try {
    const canTransfer =
      req.user?.role === "admin" ||
      (await userCanSeeAllMessages(req.user!.id, req.user!.role));
    if (!canTransfer) {
      res.status(403).json({ error: "Sem permissão para transferir conversas" });
      return;
    }
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    const userId =
      req.body?.userId === undefined || req.body?.userId === null || req.body?.userId === ""
        ? req.user!.id
        : String(req.body.userId);
    const contact = await assignContact({
      contactId,
      userId,
      queueId: req.body?.queueId ?? undefined,
    });
    res.json({ ...serializeContact(contact), ...contactFlags(contact) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/open-to-all", async (req, res) => {
  try {
    const canTransfer =
      req.user?.role === "admin" ||
      (await userCanSeeAllMessages(req.user!.id, req.user!.role));
    if (!canTransfer) {
      res.status(403).json({ error: "Sem permissão para abrir conversa para a equipe" });
      return;
    }
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    const existing = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
      select: { botFlow: true, queueId: true },
    });
    await openContactToAllSellers({
      contactId,
      queueId: req.body?.queueId ?? existing.queueId ?? undefined,
      flow: existing.botFlow === "financeiro" ? "financeiro" : "atendimento",
    });
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: { id: contactId },
      include: {
        assignedTo: { select: { id: true, name: true } },
        queue: { select: { id: true, name: true } },
      },
    });
    res.json({ ...serializeContact(contact), ...contactFlags(contact) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/resolve", async (req, res) => {
  try {
    res.json(await resolveContact(String(req.body?.contactId ?? "")));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/restart-bot", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin pode reiniciar no bot" });
      return;
    }
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    res.json(await restartToBot(contactId));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/webhook-pause", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin pode pausar o webhook" });
      return;
    }
    const contactId = String(req.body?.contactId ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    res.json(await setWebhookPaused(contactId, Boolean(req.body?.paused)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/contacts/save-name", async (req, res) => {
  try {
    const contactId = String(req.body?.contactId ?? "");
    const name = String(req.body?.name ?? "");
    if (!contactId) {
      res.status(400).json({ error: "contactId obrigatório" });
      return;
    }
    res.json(
      await saveContactName({
        contactId,
        name,
        userId: req.user!.id,
        role: req.user!.role as "admin" | "seller",
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.includes("não encontrado") ? 404 : msg.includes("Informe") ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

whatsappRouter.post("/contacts/inactivity-warn", async (req, res) => {
  try {
    res.json(
      await warnInactivity(String(req.body?.contactId ?? ""), req.user!.id)
    );
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/reports", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    res.json(
      await getWhatsAppReports({
        preset: typeof req.query.preset === "string" ? req.query.preset : undefined,
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
        month: typeof req.query.month === "string" ? req.query.month : undefined,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/reports/seed-demo", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const count = Number(req.body?.count ?? 90);
    const result = await seedDemoReports(
      Number.isFinite(count) ? Math.min(Math.max(count, 20), 200) : 90
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/connection", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default", instanceName: "", status: "disconnected" },
    });
    let live: unknown = null;
    if (evolution.credentialsOk && row.instanceName) {
      const [st, listed] = await Promise.all([
        evolution.connectionState(row.instanceName),
        evolution.fetchInstances(),
      ]);
      const instances = EvolutionClient.parseInstanceList(listed.data);
      const mine = instances.find((i) => {
        const name = String(i.name ?? i.instanceName ?? "");
        return name.toLowerCase() === row.instanceName.toLowerCase();
      });
      live = { connectionState: st.data, instance: mine ?? null };

      const fromList = mine
        ? String(mine.connectionStatus ?? mine.state ?? mine.status ?? "")
        : "";
      const fromState = st.ok ? EvolutionClient.extractLiveState(st.data) : "";
      const state = (fromList || fromState || row.status).toLowerCase();

      if (!mine && !st.ok) {
        const hint = `${st.status} ${st.text} ${listed.status} ${listed.text}`.toLowerCase();
        if (st.status === 404 || hint.includes("not found") || hint.includes("does not exist")) {
          await prisma.whatsAppConnection.update({
            where: { id: "default" },
            data: { status: "disconnected", lastQr: null, lastPairingCode: null },
          });
          row.status = "disconnected";
          row.lastQr = null;
          row.lastPairingCode = null;
        }
      } else if (state) {
        await prisma.whatsAppConnection.update({
          where: { id: "default" },
          data: { status: state },
        });
        row.status = state;
      }
    }
    if ((row.status === "open" || row.status === "connected") && row.lastPairingCode) {
      await prisma.whatsAppConnection.update({
        where: { id: "default" },
        data: { lastPairingCode: null, lastQr: null },
      });
      row.lastPairingCode = null;
      row.lastQr = null;
    }

    res.json({
      ...row,
      botEnabled: row.botEnabled !== false,
      credentialsOk: evolution.credentialsOk,
      defaultPhone: env.WHATSAPP_BUSINESS_PHONE ?? "",
      live,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/connection", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    if (!evolution.credentialsOk) {
      res.status(400).json({ error: "Configure WHATSAPP_API_URL e WHATSAPP_API_KEY no .env" });
      return;
    }
    const instanceName = String(req.body?.instanceName ?? "").trim();
    if (!instanceName) {
      res.status(400).json({ error: "Informe o nome da instância em Conectar WhatsApp" });
      return;
    }
    const number = String(req.body?.number ?? req.body?.phone ?? "").replace(/\D/g, "");
    if (number && number.length < 10) {
      res.status(400).json({ error: "Informe o telefone com DDI e DDD (ex: 556634016000)" });
      return;
    }

    const created = await evolution.createInstance(instanceName, number || undefined);
    if (!created.ok) {
      const hint = `${created.status} ${created.text}`.toLowerCase();
      const exists =
        created.status === 403 ||
        created.status === 409 ||
        hint.includes("already") ||
        hint.includes("exist") ||
        hint.includes("já existe");
      if (!exists) {
        res.status(400).json({
          error: created.text?.slice(0, 280) || `Falha ao criar instância (${created.status})`,
        });
        return;
      }
    }

    if (number) {
      const listed = await evolution.fetchInstances();
      const mine = EvolutionClient.parseInstanceList(listed.data).find((i) => {
        const name = String(i.name ?? i.instanceName ?? "");
        return name.toLowerCase() === instanceName.toLowerCase();
      });
      const liveStatus = String(mine?.connectionStatus ?? mine?.state ?? "").toLowerCase();
      if (liveStatus === "open" || liveStatus === "connected") {
        res.status(400).json({ error: "Instância já está conectada. Desconecte antes de gerar um código novo." });
        return;
      }
      if (liveStatus === "connecting") {
        await evolution.logoutInstance(instanceName).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    let connect = await evolution.connectInstance(instanceName, number || undefined);
    let pairingCode = number ? EvolutionClient.extractPairingCode(connect.data) : null;
    if (number && !pairingCode) {
      for (let i = 0; i < 3 && !pairingCode; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        connect = await evolution.connectInstance(instanceName, number);
        pairingCode = EvolutionClient.extractPairingCode(connect.data);
      }
    }
    if (number && !pairingCode) {
      res.status(400).json({
        error:
          "A Evolution não devolveu o código. Desconecte, espere uns segundos e tente de novo. Número só com DDI+DDD.",
      });
      return;
    }

    const qr = number ? null : EvolutionClient.extractQrBase64(connect.data);

    const row = await prisma.whatsAppConnection.upsert({
      where: { id: "default" },
      update: {
        instanceName,
        status: "connecting",
        lastQr: qr,
        lastPairingCode: pairingCode,
      },
      create: {
        id: "default",
        instanceName,
        status: "connecting",
        lastQr: qr,
        lastPairingCode: pairingCode,
      },
    });
    res.json({ ...row, pairingCode, connect: connect.data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/connection", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin" });
      return;
    }
    const row = await prisma.whatsAppConnection.findUnique({ where: { id: "default" } });
    if (row && evolution.credentialsOk) {
      await evolution.logoutInstance(row.instanceName).catch(() => {});
    }
    await prisma.whatsAppConnection.update({
      where: { id: "default" },
      data: { status: "disconnected", lastQr: null, lastPairingCode: null },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/queues", async (_req, res) => {
  res.json(await prisma.whatsAppQueue.findMany({ orderBy: { name: "asc" } }));
});

whatsappRouter.post("/queues", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name obrigatório" });
      return;
    }
    res.status(201).json(await prisma.whatsAppQueue.create({ data: { name } }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/queues/:id", async (req, res) => {
  try {
    await prisma.whatsAppQueue.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/agents", async (_req, res) => {
  const agents = await prisma.whatsAppAgent.findMany({
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
      queue: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(agents);
});

whatsappRouter.post("/agents", async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? "");
    const queueId = req.body?.queueId ? String(req.body.queueId) : null;
    const sortOrder = Number(req.body?.sortOrder ?? 0);
    if (!userId) {
      res.status(400).json({ error: "userId obrigatório" });
      return;
    }
    const agent = await prisma.whatsAppAgent.create({
      data: { userId, queueId, sortOrder },
      include: {
        user: { select: { id: true, name: true, email: true } },
        queue: { select: { id: true, name: true } },
      },
    });
    res.status(201).json(agent);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/flow", async (_req, res) => {
  res.json(await getFlow());
});

whatsappRouter.put("/flow", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin edita o fluxo" });
      return;
    }
    await ensureFlow();
    const options = (req.body?.options ?? []) as FlowOption[];
    const flow = await prisma.whatsAppFlow.update({
      where: { id: "default" },
      data: {
        ...(req.body?.welcomeMessage != null
          ? { welcomeMessage: String(req.body.welcomeMessage) }
          : {}),
        ...(req.body?.closedMessage != null
          ? { closedMessage: String(req.body.closedMessage) }
          : {}),
        menuEnabled: req.body?.menuEnabled !== false,
        options: options as object[],
      },
    });
    res.json(flow);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/users/:id/unavailability", async (req, res) => {
  res.json(
    await prisma.userUnavailability.findMany({
      where: { userId: req.params.id },
      orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }],
    })
  );
});

whatsappRouter.post("/users/:id/unavailability", async (req, res) => {
  try {
    if (req.user?.role !== "admin" && req.user?.id !== req.params.id) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    const row = await prisma.userUnavailability.create({
      data: {
        userId: req.params.id,
        dayOfWeek: Number(req.body?.dayOfWeek ?? 0),
        startMin: Number(req.body?.startMin ?? 0),
        endMin: Number(req.body?.endMin ?? 0),
        label: req.body?.label ? String(req.body.label) : null,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/unavailability/:id", async (req, res) => {
  try {
    await prisma.userUnavailability.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function canManageUser(req: { user?: { id: string; role: string } }, userId: string) {
  return req.user?.role === "admin" || req.user?.id === userId;
}

whatsappRouter.get("/users/:id/schedule", async (req, res) => {
  res.json(
    await prisma.userScheduleSlot.findMany({
      where: { userId: req.params.id },
      orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }],
    })
  );
});

whatsappRouter.post("/users/:id/schedule", async (req, res) => {
  try {
    if (!canManageUser(req, req.params.id)) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    const dayOfWeek = Number(req.body?.dayOfWeek);
    const startMin = Number(req.body?.startMin);
    const endMin = Number(req.body?.endMin);
    if (
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 0 ||
      dayOfWeek > 6 ||
      !Number.isFinite(startMin) ||
      !Number.isFinite(endMin) ||
      startMin < 0 ||
      endMin > 24 * 60 ||
      endMin <= startMin
    ) {
      res.status(400).json({ error: "Intervalo inválido (dia 0–6, início < fim)" });
      return;
    }
    const row = await prisma.userScheduleSlot.create({
      data: { userId: req.params.id, dayOfWeek, startMin, endMin },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/schedule/:id", async (req, res) => {
  try {
    await prisma.userScheduleSlot.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/users/:id/leaves", async (req, res) => {
  res.json(
    await prisma.userLeave.findMany({
      where: { userId: req.params.id },
      orderBy: { startsAt: "desc" },
    })
  );
});

whatsappRouter.post("/users/:id/leaves", async (req, res) => {
  try {
    if (!canManageUser(req, req.params.id)) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    const startsAt = new Date(String(req.body?.startsAt ?? ""));
    const endsAt = new Date(String(req.body?.endsAt ?? ""));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt < startsAt) {
      res.status(400).json({ error: "Informe startsAt e endsAt válidos" });
      return;
    }
    const typeRaw = String(req.body?.type ?? "outro");
    const type = ["ferias", "folga", "outro"].includes(typeRaw) ? typeRaw : "outro";
    const row = await prisma.userLeave.create({
      data: {
        userId: req.params.id,
        type,
        label: req.body?.label ? String(req.body.label) : null,
        startsAt,
        endsAt,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/leaves/:id", async (req, res) => {
  try {
    await prisma.userLeave.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.delete("/agents/:id", async (req, res) => {
  try {
    await prisma.whatsAppAgent.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      seeAllMessages: true,
      showInAttendantList: true,
      flowAtendimento: true,
      flowFinanceiro: true,
      canManageCatalog: true,
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  res.json(users);
});

whatsappRouter.patch("/users/:id", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin altera usuários" });
      return;
    }
    if (req.params.id === req.user.id && req.body?.active === false) {
      res.status(400).json({ error: "Você não pode desativar a si mesmo" });
      return;
    }
    const data: {
      active?: boolean;
      name?: string;
      role?: "admin" | "seller";
      seeAllMessages?: boolean;
      showInAttendantList?: boolean;
      flowAtendimento?: boolean;
      flowFinanceiro?: boolean;
      canManageCatalog?: boolean;
    } = {};
    if (typeof req.body?.active === "boolean") data.active = req.body.active;
    if (typeof req.body?.seeAllMessages === "boolean") {
      data.seeAllMessages = req.body.seeAllMessages;
    }
    if (typeof req.body?.showInAttendantList === "boolean") {
      data.showInAttendantList = req.body.showInAttendantList;
    }
    if (typeof req.body?.flowAtendimento === "boolean") {
      data.flowAtendimento = req.body.flowAtendimento;
    }
    if (typeof req.body?.flowFinanceiro === "boolean") {
      data.flowFinanceiro = req.body.flowFinanceiro;
    }
    if (typeof req.body?.canManageCatalog === "boolean") {
      data.canManageCatalog = req.body.canManageCatalog;
    }
    if (req.body?.role === "admin" || req.body?.role === "seller") {
      if (req.params.id === req.user!.id && req.body.role === "seller") {
        res.status(400).json({ error: "Você não pode remover seu próprio acesso de admin" });
        return;
      }
      if (req.body.role === "seller") {
        const admins = await prisma.user.count({
          where: { role: "admin", active: true, id: { not: req.params.id } },
        });
        if (admins === 0) {
          res.status(400).json({ error: "Precisa restar pelo menos um admin ativo" });
          return;
        }
      }
      data.role = req.body.role;
      // Admin já vê tudo; limpa flags de vendedor.
      if (req.body.role === "admin") {
        data.seeAllMessages = true;
        data.showInAttendantList = false;
      }
    }
    if (typeof req.body?.name === "string") {
      const name = req.body.name.trim();
      if (!name) {
        res.status(400).json({ error: "Nome obrigatório" });
        return;
      }
      data.name = name;
    }
    if (!Object.keys(data).length) {
      res.status(400).json({ error: "Nada para atualizar" });
      return;
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        seeAllMessages: true,
        showInAttendantList: true,
      },
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

whatsappRouter.post("/users", async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Só admin cria usuários" });
      return;
    }
    const user = await createUser({
      name: String(req.body?.name ?? ""),
      email: String(req.body?.email ?? ""),
      password: String(req.body?.password ?? ""),
      role: req.body?.role === "admin" ? "admin" : "seller",
      seeAllMessages: Boolean(req.body?.seeAllMessages),
      showInAttendantList:
        req.body?.showInAttendantList === undefined
          ? true
          : Boolean(req.body.showInAttendantList),
    });
    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      seeAllMessages: user.seeAllMessages,
      showInAttendantList: user.showInAttendantList,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
