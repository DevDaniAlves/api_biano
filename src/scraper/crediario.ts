import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { env } from "../config.js";
import {
  type CsvBoletoRow,
  type ExtratoApiFilter,
  buildExtratoApiFilter,
  extratoFilterLabel,
  normalizePhone,
  parseMoney,
  toYmd,
} from "../services/csv.js";
import { nowInSaoPaulo } from "../services/whatsapp/schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const API_BASE = "https://gestao.meucrediario.com.br/api";

let activeBrowser: Browser | null = null;

/** Fecha o Playwright em andamento (cancelar coleta). */
export async function abortActiveBrowser() {
  const browser = activeBrowser;
  activeBrowser = null;
  if (browser) await browser.close().catch(() => {});
}

export interface ScrapeApiResult {
  /** Modo do filtro usado (Hoje ou Informar período). */
  filterLabel: string;
  rows: CsvBoletoRow[];
  sumario: unknown;
  rawPath: string;
  /** Itens brutos extraídos antes do map (diagnóstico). */
  itemsRawCount: number;
  /** Chaves top-level da 1ª página do findAll. */
  findAllTopKeys: string[];
  /** Resposta bruta da 1ª página (para dump). */
  findAllSample: unknown;
}

/**
 * Login (Playwright) → page.request (cookies da sessão) → findAll.
 * Ter–sex: filtro "Hoje" (diasVencimento=0). Segunda: "Informar período" (sáb–seg).
 */
export async function scrapeExtratoHojeApi(): Promise<ScrapeApiResult> {
  if (!env.CREDIARIO_USER || !env.CREDIARIO_PASSWORD) {
    throw new Error("Configure CREDIARIO_USER e CREDIARIO_PASSWORD no .env");
  }

  const tmpDir = path.join(ROOT, "tmp");
  const screenshotsDir = path.join(tmpDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: env.HEADLESS });
  activeBrowser = browser;
  const context = await browser.newContext({
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  });
  const page = await context.newPage();

  const filter = buildExtratoApiFilter(nowInSaoPaulo());
  const filterLabel = extratoFilterLabel(nowInSaoPaulo());

  try {
    await login(page);
    await page.screenshot({ path: path.join(screenshotsDir, "01-login.png"), fullPage: true });

    await openReportPage(page);
    await assertGestaoSession(page, filter);

    const sumario = await callGestaoApi(page, "findAllSumario", filter);
    const { items, findAllSample, findAllTopKeys } = await fetchAllParcelas(page, filter);

    const rows = flattenAndMap(items);

    const rawPath = path.join(tmpDir, `api-extrato-${Date.now()}.json`);
    fs.writeFileSync(
      rawPath,
      JSON.stringify(
        {
          filter: filterLabel,
          filterParams: filter,
          sumario,
          findAllTopKeys,
          findAllSample,
          itemsRawCount: items.length,
          rowsMapped: rows.length,
          items: items.slice(0, 3),
          rows,
        },
        null,
        2
      ),
      "utf-8"
    );

    await page.screenshot({ path: path.join(screenshotsDir, "02-apos-api.png"), fullPage: true });

    return {
      rows,
      sumario,
      rawPath,
      itemsRawCount: items.length,
      findAllTopKeys,
      findAllSample,
      filterLabel,
    };
  } catch (err) {
    await page.screenshot({ path: path.join(screenshotsDir, "erro.png"), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close().catch(() => {});
    if (activeBrowser === browser) activeBrowser = null;
  }
}

async function login(page: Page): Promise<void> {
  await page.goto(env.CREDIARIO_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const user = page
    .locator('input[type="email"], input[name="email"], input[name="username"], #email, #username')
    .first();
  const pass = page.locator('input[type="password"]').first();
  await user.waitFor({ state: "visible", timeout: 30_000 });
  await user.fill(env.CREDIARIO_USER!);
  await pass.fill(env.CREDIARIO_PASSWORD!);
  await page
    .locator(
      'button[type="submit"], button:has-text("Acessar minha conta"), button:has-text("Acessar"), button:has-text("Entrar")'
    )
    .first()
    .click();

  await page.waitForTimeout(2000);
  await skipTwoFactorPrompt(page);

  await Promise.race([
    page.waitForURL((url) => url.hostname.includes("gestao.meucrediario.com.br"), {
      timeout: 45_000,
    }),
    page.waitForURL((url) => !url.href.includes("/login"), { timeout: 45_000 }),
    page.waitForTimeout(8000),
  ]);

  await skipTwoFactorPrompt(page);
  await openReportPage(page);
  await skipTwoFactorPrompt(page);
}

/** Tela "Ative a verificação em duas etapas" — pula e segue sem 2FA. */
async function skipTwoFactorPrompt(page: Page): Promise<void> {
  const skipBtn = page
    .locator(
      [
        'button:has-text("Acessar minha conta sem ativar")',
        'a:has-text("Acessar minha conta sem ativar")',
        'button:has-text("Entrar sem ativar")',
        'a:has-text("Entrar sem ativar")',
        '[role="button"]:has-text("sem ativar")',
      ].join(", ")
    )
    .first();

  const on2faScreen =
    (await page.getByText("verificação em duas etapas", { exact: false }).count()) > 0 ||
    (await page.getByText("Proteja sua conta", { exact: false }).count()) > 0;

  if (!on2faScreen && !(await skipBtn.isVisible().catch(() => false))) return;

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(400);

  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.scrollIntoViewIfNeeded().catch(() => {});
    await skipBtn.click({ timeout: 10_000 });
    await page.waitForTimeout(2500);
  }
}

async function openReportPage(page: Page): Promise<void> {
  await page.goto(env.CREDIARIO_REPORT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);
}

async function assertGestaoSession(page: Page, filter: ExtratoApiFilter): Promise<void> {
  await callGestaoApiOnce(page, "findAllSumario", filter);
}

async function fetchAllParcelas(
  page: Page,
  filter: ExtratoApiFilter
): Promise<{
  items: Record<string, unknown>[];
  findAllSample: unknown;
  findAllTopKeys: string[];
}> {
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let findAllSample: unknown = null;
  let findAllTopKeys: string[] = [];

  const limit = 100;
  let pageNum = 0;
  let offset = 0;

  for (;;) {
    const payload = {
      ...filter,
      page: pageNum,
      limit,
      offset,
    };
    const data = await callGestaoApi(page, "findAll", payload);
    if (pageNum === 0 && findAllSample == null) {
      findAllSample = data;
      findAllTopKeys =
        data && typeof data === "object" && !Array.isArray(data)
          ? Object.keys(data as object)
          : Array.isArray(data)
            ? ["(array)"]
            : [typeof data];
    }

    const batch = extractList(data);
    for (const item of batch) {
      const key = parcelaDedupeKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(item);
    }

    if (batch.length < limit) break;
    pageNum += 1;
    offset += limit;
    if (pageNum > 200) break;
  }

  return { items: all, findAllSample, findAllTopKeys };
}

function parcelaDedupeKey(item: Record<string, unknown>): string {
  const row = mapApiItem(item);
  if (row) return row.externalId;
  return JSON.stringify(item).slice(0, 240);
}

/** Chamada autenticada com cookies da sessão Playwright. */
async function callGestaoApi(
  page: Page,
  functionName: "findAll" | "findAllSumario",
  params: Record<string, unknown>,
  retried = false
): Promise<unknown> {
  try {
    return await callGestaoApiOnce(page, functionName, params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sessionLost =
      msg.includes("HTML") ||
      msg.includes("sessão") ||
      msg.includes("Login Meu Crediário") ||
      msg.includes("Unexpected token");
    if (!retried && sessionLost) {
      console.warn("[crediario] sessão inválida — relogin e retry", functionName);
      await login(page);
      await assertGestaoSession(page, params as ExtratoApiFilter);
      return callGestaoApiOnce(page, functionName, params);
    }
    throw err;
  }
}

async function callGestaoApiOnce(
  page: Page,
  functionName: "findAll" | "findAllSumario",
  params: Record<string, unknown>
): Promise<unknown> {
  const url = new URL(API_BASE);
  url.searchParams.set("controller", "extratoParcelasAbertas");
  url.searchParams.set("functionName", functionName);
  url.searchParams.set("params", JSON.stringify(params));

  const res = await page.request.get(url.toString(), {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://gestao.meucrediario.com.br/",
    },
  });

  const text = await res.text().catch(() => "");
  const trimmed = text.trim();

  if (!res.ok()) {
    throw new Error(`API ${functionName} HTTP ${res.status()}: ${trimmed.slice(0, 400)}`);
  }

  if (!trimmed) {
    throw new Error(`API ${functionName} resposta vazia`);
  }

  if (trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype")) {
    throw new Error(
      "Login Meu Crediário falhou ou sessão expirada (API retornou HTML). Confira CREDIARIO_USER e CREDIARIO_PASSWORD no Railway."
    );
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(
      `API ${functionName} resposta inválida (esperado JSON): ${trimmed.slice(0, 200)}`
    );
  }
}

/**
 * Extrai lista de objetos do payload (chaves conhecidas + busca recursiva).
 * Depois achata contratos com parcelas aninhadas.
 */
export function extractList(data: unknown): Record<string, unknown>[] {
  const found = findObjectArrays(data);
  if (found.length === 0) return [];

  // Prefer arrays cujos itens parecem parcela/cliente (têm contrato/nome/cpf)
  const scored = found
    .map((arr) => ({
      arr,
      score: arr.reduce((s, item) => s + scoreItem(item), 0) / Math.max(arr.length, 1),
    }))
    .sort((a, b) => b.score - a.score || b.arr.length - a.arr.length);

  const best = scored[0]?.arr ?? [];
  return flattenNestedParcelas(best);
}

function findObjectArrays(data: unknown, depth = 0): Record<string, unknown>[][] {
  if (depth > 6) return [];
  if (Array.isArray(data)) {
    if (data.length > 0 && data.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      return [data as Record<string, unknown>[]];
    }
    const nested: Record<string, unknown>[][] = [];
    for (const el of data) nested.push(...findObjectArrays(el, depth + 1));
    return nested;
  }
  if (!data || typeof data !== "object") return [];

  const obj = data as Record<string, unknown>;
  const preferredKeys = [
    "data",
    "rows",
    "items",
    "result",
    "results",
    "parcelas",
    "list",
    "lista",
    "content",
    "registros",
    "arParcelas",
    "extrato",
    "extratos",
    "contratos",
    "clientes",
    "dados",
  ];

  const out: Record<string, unknown>[][] = [];
  for (const key of preferredKeys) {
    if (key in obj) out.push(...findObjectArrays(obj[key], depth + 1));
  }
  for (const [key, val] of Object.entries(obj)) {
    if (preferredKeys.includes(key)) continue;
    // pula sumário / metadados escalares
    if (key.toLowerCase().includes("sumario")) continue;
    out.push(...findObjectArrays(val, depth + 1));
  }
  return out;
}

function scoreItem(item: Record<string, unknown>): number {
  const keys = Object.keys(item).map((k) => k.toLowerCase());
  let s = 0;
  const hits = [
    "contrato",
    "parcela",
    "cpf",
    "telefone",
    "cliente",
    "vencimento",
    "nome",
    "valor",
  ];
  for (const h of hits) {
    if (keys.some((k) => k.includes(h))) s += 1;
  }
  return s;
}

/** Se o item tem array de parcelas, explode em uma linha por parcela. */
function flattenNestedParcelas(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    const nestedKey = ["parcelas", "arParcelas", "listaParcelas", "itens"].find((k) =>
      Array.isArray(item[k])
    );
    if (nestedKey) {
      const parcelas = item[nestedKey] as unknown[];
      for (const p of parcelas) {
        if (p && typeof p === "object" && !Array.isArray(p)) {
          out.push({ ...item, ...(p as Record<string, unknown>), [nestedKey]: undefined });
        }
      }
    } else {
      out.push(item);
    }
  }
  return out;
}

function flattenAndMap(items: Record<string, unknown>[]): CsvBoletoRow[] {
  return items.map((item) => mapApiItem(item)).filter((r): r is CsvBoletoRow => r !== null);
}

/** Mapeia item JSON da API → linha padronizada (UI / CSV). */
export function mapApiItem(item: Record<string, unknown>): CsvBoletoRow | null {
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      const v = deepGet(item, k);
      if (v == null) continue;
      if (typeof v === "object") continue;
      const s = String(v).trim();
      if (s !== "" && s.toLowerCase() !== "null" && s !== "[object Object]") return s;
    }
    return "";
  };

  // Parcela pode vir como "4/5" ou numeroParcela + totalParcelas
  let parcela = get(
    "parcela",
    "nrParcela",
    "numeroParcela",
    "parcelaAtual",
    "nroParcela",
    "nuParcela"
  );
  if (!parcela) {
    const n = get("numeroParcela", "nrParcela", "parcelaNumero");
    const t = get("totalParcelas", "qtdParcelas", "quantidadeParcelas");
    if (n && t) parcela = `${n}/${t}`;
    else if (n) parcela = n;
  }

  const clienteNome = get(
    "nomeCliente",
    "nome_cliente",
    "clienteNome",
    "nmCliente",
    "nome",
    "cliente.nome",
    "cliente.nomeCliente"
  );
  const contrato = get(
    "contrato",
    "codigoContrato",
    "nrContrato",
    "idContrato",
    "codContrato",
    "numeroContrato"
  );
  const vencimentoRaw = get(
    "dataVencimento",
    "dtVencimento",
    "vencimento",
    "data_vencimento",
    "dt_vencimento",
    "dataVenc"
  );
  const vencimento = vencimentoRaw ? toYmd(vencimentoRaw) : "";

  if (!clienteNome || !contrato || !parcela || !vencimento) return null;

  const valorVencimento = parseMoney(
    get(
      "valorVencimento",
      "vlVencimento",
      "valorDeVencimento",
      "valor",
      "valorParcela",
      "vlParcela"
    ) || "0"
  );

  return {
    externalId: `${contrato}-${parcela}-${vencimento}`,
    cpf: get("cpf", "cpfCliente", "documento", "cliente.cpf", "nrCpf"),
    clienteNome,
    clienteTelefone: normalizePhone(
      get(
        "telefone",
        "telefoneCliente",
        "celular",
        "fone",
        "whatsapp",
        "cliente.telefone",
        "nrTelefone",
        "telefoneCelular"
      )
    ),
    codigoCliente: get(
      "codigoCliente",
      "codCliente",
      "idCliente",
      "cliente.codigo",
      "cdCliente",
      "codigo_cliente"
    ),
    risco: emptyToNull(
      get("risco", "descricaoRisco", "riscoCliente", "dsRisco", "labelRisco", "vendaSemAnalise")
    ),
    contrato,
    dataVenda: emptyToNull(get("dataVenda", "dtVenda", "data_venda", "dt_venda")),
    parcela,
    vencimento,
    valorVencimento,
    totalPago: nullableMoney(get("totalPago", "vlTotalPago", "valorPago", "total_pago")),
    valorQuitacao: nullableMoney(
      get(
        "valorQuitacao",
        "vlQuitacao",
        "valorQuitacaoHoje",
        "valorDeQuitacao",
        "vlQuitacaoHoje"
      )
    ),
    capitalAberto: nullableMoney(
      get("capitalAberto", "vlCapitalAberto", "capital", "capitalEmAberto", "vlCapital")
    ),
    descontoQuitacao: nullableMoney(
      get("descontoQuitacao", "vlDescontoQuitacao", "descontoDeQuitacao")
    ),
    situacao: emptyToNull(
      get(
        "situacao",
        "situacaoParcela",
        "status",
        "labelSituacao",
        "dsSituacao",
        "situacaoVencimento"
      )
    ),
  };
}

function deepGet(obj: Record<string, unknown>, pathKey: string): unknown {
  if (!pathKey.includes(".")) {
    // case-insensitive fallback
    if (pathKey in obj) return obj[pathKey];
    const lower = pathKey.toLowerCase();
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  const parts = pathKey.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = deepGet(cur as Record<string, unknown>, p);
  }
  return cur;
}

function emptyToNull(v: string): string | null {
  return v ? v : null;
}

function nullableMoney(raw: string): number | null {
  if (!raw) return null;
  return parseMoney(raw);
}

/** Quantidade esperada no sumário (se existir). */
export function sumarioQtdTotal(sumario: unknown): number {
  if (!sumario || typeof sumario !== "object") return 0;
  const root = sumario as Record<string, unknown>;
  const inner =
    root.sumario && typeof root.sumario === "object"
      ? (root.sumario as Record<string, unknown>)
      : root;
  const q = inner.qtdTotal ?? inner.qtd ?? inner.total ?? inner.count;
  return typeof q === "number" ? q : Number(q) || 0;
}

/** @deprecated Mantido se quiser fallback CSV; scrape principal usa a API. */
export async function scrapeExtratoHojeCsv(): Promise<{ csvPath: string; csvContent: Buffer }> {
  const { rows, rawPath } = await scrapeExtratoHojeApi();
  const header = [
    "CPF",
    "Nome do cliente",
    "Telefone do Cliente",
    "Código do cliente",
    "Risco",
    "Contrato",
    "Data da Venda",
    "Parcela",
    "Data de vencimento",
    "Valor de vencimento",
    "Total Pago",
    "Valor de quitação",
    "Capital aberto",
    "Desconto de quitação",
    "Situação",
  ];
  const lines = [
    header.join(";"),
    ...rows.map((r) =>
      [
        r.cpf,
        r.clienteNome,
        r.clienteTelefone,
        r.codigoCliente,
        r.risco ?? "",
        r.contrato,
        r.dataVenda ?? "",
        r.parcela,
        r.vencimento,
        r.valorVencimento,
        r.totalPago ?? "",
        r.valorQuitacao ?? "",
        r.capitalAberto ?? "",
        r.descontoQuitacao ?? "",
        r.situacao ?? "",
      ].join(";")
    ),
  ];
  const csvContent = Buffer.from(lines.join("\n"), "utf-8");
  const csvPath = rawPath.replace(/\.json$/, ".csv");
  fs.writeFileSync(csvPath, csvContent);
  return { csvPath, csvContent };
}
