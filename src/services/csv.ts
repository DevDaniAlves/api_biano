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

export function todayYmd(): string {
  const tz = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const d = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}
