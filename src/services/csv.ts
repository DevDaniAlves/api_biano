import { parse } from "csv-parse/sync";

export interface CsvBoletoRow {
  externalId: string;
  cpf: string;
  clienteNome: string;
  clienteTelefone: string;
  codigoCliente: string;
  risco: string | null;
  contrato: string;
  dataVenda: string | null;
  parcela: string;
  vencimento: string;
  valorVencimento: number;
  totalPago: number | null;
  valorQuitacao: number | null;
  capitalAberto: number | null;
  descontoQuitacao: number | null;
  situacao: string | null;
}

const HEADER_MAP: Record<string, string> = {
  cpf: "cpf",
  "nome do cliente": "clienteNome",
  "telefone do cliente": "clienteTelefone",
  "código do cliente": "codigoCliente",
  "codigo do cliente": "codigoCliente",
  risco: "risco",
  contrato: "contrato",
  "data da venda": "dataVenda",
  parcela: "parcela",
  "data de vencimento": "vencimento",
  "valor de vencimento": "valorVencimento",
  "total pago": "totalPago",
  "valor de quitação": "valorQuitacao",
  "valor de quitacao": "valorQuitacao",
  "capital aberto": "capitalAberto",
  "desconto de quitação": "descontoQuitacao",
  "desconto de quitacao": "descontoQuitacao",
  situação: "situacao",
  situacao: "situacao",
};

export function parseExtratoCsv(content: string | Buffer): CsvBoletoRow[] {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  const cleaned = text.replace(/^\uFEFF/, "").trim();

  const records = parse(cleaned, {
    columns: true,
    delimiter: detectDelimiter(cleaned),
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];

  return records
    .map((raw) => normalizeRow(raw))
    .filter((r): r is CsvBoletoRow => r !== null);
}

function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? "";
  const semis = (first.match(/;/g) ?? []).length;
  const commas = (first.match(/,/g) ?? []).length;
  return semis >= commas ? ";" : ",";
}

function normalizeRow(raw: Record<string, string>): CsvBoletoRow | null {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const norm = key.trim().toLowerCase();
    const field = HEADER_MAP[norm];
    if (field) mapped[field] = value?.trim() ?? "";
  }

  const contrato = mapped.contrato ?? "";
  const parcela = mapped.parcela ?? "";
  const vencimento = toYmd(mapped.vencimento ?? "");
  const clienteNome = mapped.clienteNome ?? "";

  if (!contrato || !parcela || !vencimento || !clienteNome) return null;

  return {
    externalId: `${contrato}-${parcela}-${vencimento}`,
    cpf: mapped.cpf ?? "",
    clienteNome,
    clienteTelefone: normalizePhone(mapped.clienteTelefone ?? ""),
    codigoCliente: mapped.codigoCliente ?? "",
    risco: emptyToNull(mapped.risco),
    contrato,
    dataVenda: emptyToNull(mapped.dataVenda),
    parcela,
    vencimento,
    valorVencimento: parseMoney(mapped.valorVencimento ?? "0"),
    totalPago: parseMoneyNullable(mapped.totalPago),
    valorQuitacao: parseMoneyNullable(mapped.valorQuitacao),
    capitalAberto: parseMoneyNullable(mapped.capitalAberto),
    descontoQuitacao: parseMoneyNullable(mapped.descontoQuitacao),
    situacao: emptyToNull(mapped.situacao),
  };
}

function emptyToNull(v?: string): string | null {
  if (!v || v.toLowerCase() === "null") return null;
  return v;
}

export function parseMoney(raw: string): number {
  const cleaned = raw.replace(/[R$\s]/gi, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "null") return 0;
  if (cleaned.includes(",")) {
    return Number(cleaned.replace(/\./g, "").replace(",", ".")) || 0;
  }
  return Number(cleaned) || 0;
}

function parseMoneyNullable(raw?: string): number | null {
  if (!raw || raw.toLowerCase() === "null") return null;
  return parseMoney(raw);
}

export function toYmd(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}

export function todayYmd(now?: Date): string {
  const tz =
    now ?? new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const d = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Filtro da API Gestão (espelha a tela Extrato de parcelas em aberto). */
export type ExtratoApiFilter = {
  arLojas: null;
  diasVencimento: number | null;
  dataVencimentoi: string | null;
  dataVencimentof: string | null;
  arRiscosSelecionados: string[];
  arPlanosSemEntradaSelecionados: string[];
  arPlanosEntradaSelecionados: string[];
  arSituacaoParcelaSelecionados: string[];
  cliente: null;
  contrato: null;
};

function saoPauloNow(now?: Date): Date {
  return now ?? new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
}

/** DD/MM/YYYY — formato usado na UI "Informar período". */
export function toBrDate(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

/** Segunda = período (sáb–seg); terça a sexta = Hoje. Feriados usam filters por lista de vencimentos. */
export function extratoFilterMode(now?: Date): "hoje" | "periodo" {
  return saoPauloNow(now).getDay() === 1 ? "periodo" : "hoje";
}

function extratoApiFilterBase(): ExtratoApiFilter {
  return {
    arLojas: null,
    arRiscosSelecionados: [],
    arPlanosSemEntradaSelecionados: [],
    arPlanosEntradaSelecionados: [],
    arSituacaoParcelaSelecionados: [],
    cliente: null,
    contrato: null,
    diasVencimento: null,
    dataVencimentoi: null,
    dataVencimentof: null,
  };
}

/** Diferença em dias: toYmd − fromYmd (negativo se to é anterior). */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [y1, m1, d1] = fromYmd.split("-").map(Number);
  const [y2, m2, d2] = toYmd.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86_400_000);
}

/** Um filtro (compat). Preferir buildExtratoApiFiltersForVencimentos. */
export function buildExtratoApiFilter(now?: Date): ExtratoApiFilter {
  return buildExtratoApiFiltersForScrape(now)[0]!;
}

/**
 * Segunda: 3 chamadas diasVencimento (-2 sáb, -1 dom, 0 seg).
 * Preferir buildExtratoApiFiltersForVencimentos quando há feriados.
 */
export function buildExtratoApiFiltersForScrape(now?: Date): ExtratoApiFilter[] {
  const sp = saoPauloNow(now);
  const base = extratoApiFilterBase();

  if (sp.getDay() === 1) {
    return [-2, -1, 0].map((diasVencimento) => ({
      ...base,
      diasVencimento,
      dataVencimentoi: null,
      dataVencimentof: null,
    }));
  }

  return [
    {
      ...base,
      diasVencimento: 0,
      dataVencimentoi: null,
      dataVencimentof: null,
    },
  ];
}

/** Uma chamada findAll por vencimento (diasVencimento relativo a hoje). */
export function buildExtratoApiFiltersForVencimentos(
  vencimentos: string[],
  now?: Date
): ExtratoApiFilter[] {
  const hoje = todayYmd(saoPauloNow(now));
  const base = extratoApiFilterBase();
  const dates = [...new Set(vencimentos.map((v) => v.trim()).filter(Boolean))].sort();
  if (dates.length === 0) {
    return [
      {
        ...base,
        diasVencimento: 0,
        dataVencimentoi: null,
        dataVencimentof: null,
      },
    ];
  }
  return dates.map((ymd) => ({
    ...base,
    diasVencimento: daysBetweenYmd(hoje, ymd),
    dataVencimentoi: null,
    dataVencimentof: null,
  }));
}

export function extratoFilterLabel(now?: Date): string {
  if (extratoFilterMode(now) === "periodo") {
    const v = vencimentosParaDisparoHoje(now);
    return `Informar período (${toBrDate(v[0]!)} – ${toBrDate(v[v.length - 1]!)})`;
  }
  return "Hoje";
}

export function extratoFilterLabelForVencimentos(vencimentos: string[]): string {
  const dates = [...new Set(vencimentos.map((v) => v.trim()).filter(Boolean))].sort();
  if (dates.length === 0) return "Hoje (sem vencimentos)";
  if (dates.length === 1) {
    return dates[0] === todayYmd() ? "Hoje" : `Vencimento ${toBrDate(dates[0]!)}`;
  }
  return `Informar período (${toBrDate(dates[0]!)} – ${toBrDate(dates[dates.length - 1]!)})`;
}

/**
 * Vencimentos a disparar na automação/manual “hoje” (sem feriados).
 * Segunda-feira: sábado + domingo + hoje.
 * Com feriados use vencimentosParaDisparoComFeriados em closures.ts.
 */
export function vencimentosParaDisparoHoje(now?: Date): string[] {
  const sp =
    now ?? new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hoje = todayYmd(sp);
  if (sp.getDay() === 1) {
    return [addDaysYmd(hoje, -2), addDaysYmd(hoje, -1), hoje];
  }
  return [hoje];
}

export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}
