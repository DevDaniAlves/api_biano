import type { Boleto } from "@prisma/client";
import { env } from "../config.js";
import { prisma } from "../db.js";
import type { CsvBoletoRow } from "./csv.js";

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

export function renderMessage(boleto: Boleto, template = env.MESSAGE_TEMPLATE): string {
  const valorFmt = boleto.valorVencimento.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const venc = formatBrDate(boleto.vencimento);

  return template
    .replaceAll("\\n", "\n")
    .replaceAll("{{nome}}", boleto.clienteNome)
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

async function sendWhatsApp(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!env.WHATSAPP_API_URL) {
    return { ok: false, error: "WHATSAPP_API_URL não configurada" };
  }
  const number = phone.replace(/\D/g, "");
  if (number.length < 12) return { ok: false, error: `Telefone inválido: ${phone}` };

  const url = buildEvolutionSendTextUrl(env.WHATSAPP_API_URL, env.WHATSAPP_INSTANCE);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.WHATSAPP_API_KEY) {
    headers.apikey = env.WHATSAPP_API_KEY;
  }

  const body = {
    number,
    text,
    delay: 1200,
    linkPreview: false,
  };

  console.log(`[whatsapp] POST ${url}`);
  console.log(`[whatsapp] number=${number} textLen=${text.length}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const detail = await res.text().catch(() => "");
    console.log(`[whatsapp] status=${res.status} body=${detail.slice(0, 500)}`);

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${detail.slice(0, 500)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[whatsapp] ERRO de rede:`, err);
    return { ok: false, error: msg };
  }
}

/** Monta URL Evolution v2: {base}/message/sendText/{instance} */
function buildEvolutionSendTextUrl(base: string, instance?: string): string {
  let url = base.trim().replace(/\/$/, "");

  if (url.includes("{instance}") && instance) {
    return url.replaceAll("{instance}", instance);
  }

  // Já é o endpoint completo
  if (/\/message\/sendText(\/|$)/i.test(url)) {
    if (instance && !url.endsWith(`/${instance}`) && !/\/message\/sendText\/[^/]+$/i.test(url)) {
      return `${url}/${instance}`;
    }
    return url;
  }

  // Só o host (ex.: Railway) → completa o path
  if (instance) {
    return `${url}/message/sendText/${instance}`;
  }
  return `${url}/message/sendText`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveDispatchPhone(boletoPhone: string): string {
  const override = env.WHATSAPP_OVERRIDE_PHONE?.replace(/\D/g, "") ?? "";
  if (override) {
    return override.length === 10 || override.length === 11 ? `55${override}` : override;
  }
  return boletoPhone.replace(/\D/g, "");
}

export async function dispatchPending(vencimento?: string) {
  const where = {
    status: "pending" as const,
    ...(vencimento ? { vencimento } : {}),
  };

  const boletos = await prisma.boleto.findMany({ where, orderBy: { clienteNome: "asc" } });
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  console.log(
    `[dispatch] início: ${boletos.length} pending | url=${env.WHATSAPP_API_URL} | instance=${env.WHATSAPP_INSTANCE ?? "-"} | override=${env.WHATSAPP_OVERRIDE_PHONE ?? "-"}`
  );

  for (const b of boletos) {
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
    const result = await sendWhatsApp(phone, text);

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

    if (env.DISPATCH_DELAY_MS > 0) await sleep(env.DISPATCH_DELAY_MS);
  }

  console.log(`[dispatch] fim: sent=${sent} failed=${failed} skipped=${skipped}`);
  return { total: boletos.length, sent, failed, skipped };
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
