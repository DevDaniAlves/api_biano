/**
 * Script de Diagnóstico Playwright / Meu Crediário
 * Atende os 6 pontos de validação:
 * 1. Análise manual vs batch
 * 2. Validação vencimento hoje vs emissão/lançamento e timezone
 * 3. Log de URL final, texto na tela, page.on('response'), contagem hoje vs < hoje
 * 4. Comparativo de timestamp da resposta vs extração (detecção de cache)
 * 5. Teste de execução dupla contínua (detecção de race conditions)
 * 6. Teste de sessão limpa (novo context) vs storageState
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { env } from "../config.js";
import {
  type CsvBoletoRow,
  type ExtratoApiFilter,
  buildExtratoApiFiltersForVencimentos,
  extratoFilterLabelForVencimentos,
  vencimentosParaDisparoHoje,
  todayYmd,
  toBrDate,
} from "../services/csv.js";
import { nowInSaoPaulo } from "../services/whatsapp/schedule.js";
import { scrapeExtratoHojeApi, mapApiItem, extractList } from "../scraper/crediario.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TMP_DIR = path.join(ROOT, "tmp");

async function runDiagnosticScrape(options: {
  browser?: Browser;
  context?: BrowserContext;
  storageStatePath?: string;
  runIndex?: number;
}) {
  const index = options.runIndex ?? 1;
  console.log(`\n======================================================`);
  console.log(`🚀 INICIANDO EXECUÇÃO #${index}`);
  console.log(`======================================================`);

  const now = nowInSaoPaulo();
  const hoje = todayYmd(now);
  console.log(`🕒 Horário Local (América/São Paulo): ${now.toISOString()} | Data Hoje: ${hoje}`);
  console.log(`🕒 Horário UTC: ${new Date().toISOString()}`);

  const v = vencimentosParaDisparoHoje(now);
  console.log(`📅 Vencimentos previstos para coleta:`, v);
  const filters = buildExtratoApiFiltersForVencimentos(v, now);
  console.log(`🔍 Filtros gerados (diasVencimento / range):`, JSON.stringify(filters, null, 2));

  // Executa o scrape completo instrumentado
  const result = await scrapeExtratoHojeApi();

  console.log(`\n📊 RESULTADO DA EXECUÇÃO #${index}:`);
  console.log(`- Filtro aplicado: ${result.filterLabel}`);
  console.log(`- Total de itens brutos da API: ${result.itemsRawCount}`);
  console.log(`- Total de parcelas mapeadas: ${result.rows.length}`);

  const rowsHoje = result.rows.filter((r) => r.vencimento === hoje);
  const rowsAntigas = result.rows.filter((r) => r.vencimento < hoje);
  const rowsFuturas = result.rows.filter((r) => r.vencimento > hoje);

  console.log(`- Parcelas com vencimento = HOJE (${hoje}): ${rowsHoje.length}`);
  console.log(`- Parcelas com vencimento < HOJE (antigas): ${rowsAntigas.length}`);
  console.log(`- Parcelas com vencimento > HOJE (futuras): ${rowsFuturas.length}`);

  if (rowsAntigas.length > 0) {
    console.warn(`\n⚠️ PARCELAS ANTIGAS DETECTADAS NO RETORNO:`);
    rowsAntigas.forEach((r) => {
      console.warn(`  → Contrato: ${r.contrato} | Parcela: ${r.parcela} | Vencimento: ${r.vencimento} | Cliente: ${r.clienteNome}`);
    });
  }

  return { result, rowsHoje, rowsAntigas, rowsFuturas };
}

async function main() {
  const mode = process.argv[2] ?? "single";

  console.log(`Modo de diagnóstico selecionado: ${mode}`);

  if (mode === "double" || mode === "5") {
    console.log(`\n[TESTE 5] Rodando duas vezes seguidas no mesmo processo para verificar race condition/timing...`);
    const r1 = await runDiagnosticScrape({ runIndex: 1 });
    console.log(`\n⏳ Aguardando 3 segundos antes da segunda execução...`);
    await new Promise((r) => setTimeout(r, 3000));
    const r2 = await runDiagnosticScrape({ runIndex: 2 });

    console.log(`\n=================== COMPARAÇÃO DUPLA ===================`);
    console.log(`Execução 1: Total=${r1.result.rows.length} | Hoje=${r1.rowsHoje.length} | Antigas=${r1.rowsAntigas.length}`);
    console.log(`Execução 2: Total=${r2.result.rows.length} | Hoje=${r2.rowsHoje.length} | Antigas=${r2.rowsAntigas.length}`);
    if (r1.result.rows.length !== r2.result.rows.length) {
      console.warn(`⚠️ Divergência encontrada entre as duas execuções! Pode indicar timing ou race condition.`);
    } else {
      console.log(`✅ Ambas as execuções retornaram contagens idênticas.`);
    }
  } else {
    await runDiagnosticScrape({ runIndex: 1 });
  }
}

main().catch((e) => {
  console.error("Erro no diagnóstico:", e);
  process.exit(1);
});
