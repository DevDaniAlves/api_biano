import type { Boleto } from "@prisma/client";
import { env } from "../config.js";
import { prisma } from "../db.js";
import type { CsvBoletoRow } from "./csv.js";
import { activeProvider, sendOutbound } from "./whatsapp/gateway.js";
import { evolution } from "./whatsapp/evolution.js";

export async function upsertBoletosFromCsv(
  rows: CsvBoletoRow[],
  jobId?: string
): Promise<{ upserted: number }> {
  let upserted = 0;

  for (const row of rows) {
    const existing = await prisma.boleto.findUnique({
      where: {
        contrato_parcela_vencimento: {
          contrato: row.contrato,
          parcela: row.parcela,
          vencimento: row.vencimento,
        },
      },
    });

    // Não altera boletos já enviados
    if (existing?.status === "sent") continue;

    await prisma.boleto.upsert({
      where: {
        contrato_parcela_vencimento: {
          contrato: row.contrato,
          parcela: row.parcela,
          vencimento: row.vencimento,
        },
      },
      create: {
        ...row,
        status: "pending",
        jobId: jobId ?? null,
      },
      update: {
        cpf: row.cpf,
        clienteNome: row.clienteNome,
        clienteTelefone: row.clienteTelefone,
        codigoCliente: row.codigoCliente,
        risco: row.risco,
        dataVenda: row.dataVenda,
        valorVencimento: row.valorVencimento,
        totalPago: row.totalPago,
        valorQuitacao: row.valorQuitacao,
        capitalAberto: row.capitalAberto,
        descontoQuitacao: row.descontoQuitacao,
        situacao: row.situacao,
        externalId: row.externalId,
        collectedAt: new Date(),
        jobId: jobId ?? undefined,
        ...(existing?.status === "failed" || existing?.status === "skipped"
          ? { status: "pending" as const, dispatchError: null }
          : {}),
      },
    });
    upserted++;
  }

  return { upserted };
}

function firstName(full: string): string {
  const part = full.trim().split(/\s+/).find(Boolean) ?? full.trim();
  if (!part) return full.trim();
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

export function renderMessage(boleto: Boleto, template = env.MESSAGE_TEMPLATE): string {
  const valorFmt = boleto.valorVencimento.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const venc = formatBrDate(boleto.vencimento);

  return template
    .replaceAll("\\n", "\n")
    .replaceAll("{{nome}}", firstName(boleto.clienteNome))
    .replaceAll("{{valor}}", valorFmt)
    .replaceAll("{{vencimento}}", venc)
    .replaceAll("{{parcela}}", boleto.parcela)
    .replaceAll("{{contrato}}", boleto.contrato)
    .replaceAll("{{telefone}}", boleto.clienteTelefone)
    .replaceAll("{{cpf}}", boleto.cpf)
    .replaceAll("{{link}}", env.CREDIARIO_CLIENTE_LINK);
}

function formatBrDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return ymd;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

async function sendWhatsApp(
  phone: string,
  text: string,
  boleto: Boleto
): Promise<{ ok: boolean; error?: string }> {
  const number = phone.replace(/\D/g, "");
  if (number.length < 12) return { ok: false, error: `Telefone inválido: ${phone}` };

  const provider = await activeProvider();
  if (provider === "meta") {
    const templateName = (env.META_BOLETO_TEMPLATE_NAME || "").trim();
    if (!templateName) {
      return {
        ok: false,
        error: "META_BOLETO_TEMPLATE_NAME não configurado (template Utility aprovado)",
      };
    }
    const valorFmt = boleto.valorVencimento.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const r = await sendOutbound({
      to: number,
      source: "boleto",
      boletoId: boleto.id,
      kind: "template",
      category: "utility",
      billable: true,
      bodyPreview: text,
      template: {
        name: templateName,
        language: env.META_BOLETO_TEMPLATE_LANG,
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: firstName(boleto.clienteNome) },
              { type: "text", text: valorFmt },
              { type: "text", text: formatBrDate(boleto.vencimento) },
              { type: "text", text: env.CREDIARIO_CLIENTE_LINK },
            ],
          },
        ],
      },
    });
    return { ok: r.ok, error: r.error };
  }

  if (provider === "gupshup") {
    const templateId = (env.GUPSHUP_BOLETO_TEMPLATE_ID || "").trim();
    if (!templateId) {
      return {
        ok: false,
        error: "GUPSHUP_BOLETO_TEMPLATE_ID não configurado (template no painel Gupshup)",
      };
    }
    const valorFmt = boleto.valorVencimento.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const r = await sendOutbound({
      to: number,
      source: "boleto",
      boletoId: boleto.id,
      kind: "template",
      category: "utility",
      billable: true,
      bodyPreview: text,
      template: {
        name: templateId,
        gupshupId: templateId,
        params: [
          firstName(boleto.clienteNome),
          valorFmt,
          formatBrDate(boleto.vencimento),
          env.CREDIARIO_CLIENTE_LINK,
        ],
      },
    });
    return { ok: r.ok, error: r.error };
  }

  const instance = await evolution.resolveInstance();
  if (!instance) {
    return { ok: false, error: "WhatsApp não conectado. Conecte pelo QR em Conectar." };
  }
  const r = await sendOutbound({
    to: phone,
    source: "boleto",
    boletoId: boleto.id,
    kind: "text",
    text,
    category: "free",
    billable: false,
    bodyPreview: text,
  });
  return { ok: r.ok, error: r.error };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let dispatchGeneration = 0;
let dispatchRunning = false;

export function cancelActiveDispatch() {
  dispatchGeneration += 1;
}

export function isDispatchRunning() {
  return dispatchRunning;
}

async function sleepWhileActive(ms: number, token: number) {
  const step = 500;
  let left = ms;
  while (left > 0) {
    if (token !== dispatchGeneration) return;
    const chunk = Math.min(step, left);
    await sleep(chunk);
    left -= chunk;
  }
}

/** Pausa aleatória de 1 a 2 minutos entre disparos. */
function randomDispatchDelayMs() {
  return 60_000 + Math.floor(Math.random() * 60_001);
}

function resolveDispatchPhone(boletoPhone: string): string {
  const override = env.WHATSAPP_OVERRIDE_PHONE?.replace(/\D/g, "") ?? "";
  if (override) {
    return override.length === 10 || override.length === 11 ? `55${override}` : override;
  }
  return boletoPhone.replace(/\D/g, "");
}

export async function dispatchPending(vencimento?: string) {
  cancelActiveDispatch();
  const token = dispatchGeneration;
  dispatchRunning = true;

  try {
    const where = {
      status: "pending" as const,
      ...(vencimento ? { vencimento } : {}),
    };

    const boletos = await prisma.boleto.findMany({ where, orderBy: { clienteNome: "asc" } });
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    const provider = await activeProvider();
    const instance = provider === "evolution" ? await evolution.resolveInstance() : "";
    console.log(
      `[dispatch] início: ${boletos.length} pending | provider=${provider} | instance=${instance || "-"} | override=${env.WHATSAPP_OVERRIDE_PHONE ?? "-"}`
    );

    for (let i = 0; i < boletos.length; i++) {
      if (token !== dispatchGeneration) {
        console.log("[dispatch] cancelado para iniciar novo disparo");
        break;
      }
      const b = boletos[i];
      const phone = resolveDispatchPhone(b.clienteTelefone);
      if (!phone || phone.length < 12) {
        console.warn(`[dispatch] SKIP #${b.id} telefone inválido: ${b.clienteTelefone}`);
        await prisma.boleto.update({
          where: { id: b.id },
          data: { status: "skipped", dispatchError: "Telefone inválido" },
        });
        skipped++;
        continue;
      }

      const text = renderMessage(b);
      console.log(
        `[dispatch] #${b.id} ${b.clienteNome} → ${phone}` +
          (env.WHATSAPP_OVERRIDE_PHONE ? " (override)" : "")
      );
      const result = await sendWhatsApp(phone, text, b);

      if (result.ok) {
        console.log(`[dispatch] OK #${b.id}`);
        await prisma.boleto.update({
          where: { id: b.id },
          data: { status: "sent", dispatchedAt: new Date(), dispatchError: null },
        });
        sent++;
      } else {
        console.error(`[dispatch] FALHA #${b.id}: ${result.error}`);
        await prisma.boleto.update({
          where: { id: b.id },
          data: {
            status: "failed",
            dispatchedAt: new Date(),
            dispatchError: result.error?.slice(0, 1000),
          },
        });
        failed++;
      }

      const hasMore = boletos.slice(i + 1).some((next) => {
        const p = resolveDispatchPhone(next.clienteTelefone);
        return p && p.length >= 12;
      });
      if (hasMore) {
        const ms = randomDispatchDelayMs();
        console.log(`[dispatch] pausa ${Math.round(ms / 1000)}s até o próximo`);
        await sleepWhileActive(ms, token);
      }
    }

    console.log(`[dispatch] fim: sent=${sent} failed=${failed} skipped=${skipped}`);
    return { total: boletos.length, sent, failed, skipped };
  } finally {
    if (token === dispatchGeneration) dispatchRunning = false;
  }
}

/** Dispara pending para várias datas de vencimento (ex.: seg → sáb, dom, hoje). */
export async function dispatchPendingForVencimentos(vencimentos: string[]) {
  const dates = [...new Set(vencimentos.map((v) => v.trim()).filter(Boolean))];
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  for (const vencimento of dates) {
    console.log(`[dispatch] vencimento ${vencimento}`);
    const r = await dispatchPending(vencimento);
    sent += r.sent;
    failed += r.failed;
    skipped += r.skipped;
    total += r.total;
  }
  return { total, sent, failed, skipped, vencimentos: dates };
}

/** Volta sent/failed/skipped → pending (para retestar disparo). */
export async function resetDispatchStatus(vencimento?: string) {
  const where = {
    status: { in: ["sent", "failed", "skipped"] as ("sent" | "failed" | "skipped")[] },
    ...(vencimento ? { vencimento } : {}),
  };

  const result = await prisma.boleto.updateMany({
    where,
    data: {
      status: "pending",
      dispatchError: null,
      dispatchedAt: null,
    },
  });

  return { reset: result.count };
}
