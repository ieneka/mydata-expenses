import table from './data/expense-combinations-v2.0.2.json';

/**
 * Validator for expense classifications (invoice type × category × E3 code).
 * Data: AADE's official combinations table, version 2.0.2 (expense columns).
 * It does not decide which classification is right (that is a person's or a model's job): it only says whether AADE
 * accepts it.
 */

/** Version of the bundled official table; review it when AADE publishes a new one. */
export const EXPENSE_TABLE_VERSION: string = table.version;

/** Well-formed E3 code, e.g. E3_585_016 or E3_586. */
export const E3_CODE_PATTERN = /^E3_\d{3}(_\d{3})?$/;

type Entry = Record<string, number | string | null> | 'related';
const types = table.types as Record<string, Entry>;
const e3Lists = table.e3Lists.map(l => l.split(' ').map(c => `E3_${c}`));

/** 'category2_4' → '2_4' (table key). */
const categoryKey = (category: string) => category.replace(/^category/, '');

export type ClassificationIssue =
  | 'unknown_invoice_type'
  | 'invoice_type_without_expenses'
  | 'depends_on_related'
  | 'category_not_allowed'
  | 'e3_malformed'
  | 'e3_not_allowed';

export type ClassificationCheck =
  | { ok: true }
  | { ok: false; issue: ClassificationIssue; message: string; allowedCategories?: string[]; allowedE3?: string[] };

/**
 * What the official table accepts for an invoice type:
 * - `ok`: it has expense combinations.
 * - `no_expenses`: it accepts no expense classification (e.g. 11.x, retail receipts): nothing to classify.
 * - `related`: the values depend on the related invoices (1.6, 2.4, 5.1).
 * - `unknown`: not in the bundled table version.
 */
export function expenseTypeSupport(invoiceType: string): 'ok' | 'no_expenses' | 'related' | 'unknown' {
  const entry = types[invoiceType];
  if (!entry) return 'unknown';
  if (entry === 'related') return 'related';
  return Object.keys(entry).length > 0 ? 'ok' : 'no_expenses';
}

/** Expense categories AADE accepts for the invoice type (empty if it accepts none). */
export function allowedCategories(invoiceType: string): string[] {
  const entry = types[invoiceType];
  if (!entry || entry === 'related') return [];
  return Object.keys(entry).map(k => `category${k}`);
}

/**
 * E3 codes AADE accepts for that invoice type and category.
 * `[]` if the category takes no E3 code (e.g. category2_95); `undefined` if the combination does not exist.
 */
export function allowedE3(invoiceType: string, category: string): string[] | undefined {
  const entry = types[invoiceType];
  if (!entry || entry === 'related') return undefined;
  const v = entry[categoryKey(category)];
  if (v === undefined) return undefined;
  if (v === null) return [];
  // '*' (categories 2_10 and 2_11): any code allowed for the type's other categories is valid
  if (v === '*') return [...new Set(Object.values(entry).filter((x): x is number => typeof x === 'number').flatMap(i => e3Lists[i]))];
  return e3Lists[v as number];
}

/** Checks the invoice type + category + E3 code combination against the official table. */
export function validateExpenseClassification(invoiceType: string, category: string, e3Code: string): ClassificationCheck {
  const entry = types[invoiceType];
  if (!entry) {
    return { ok: false, issue: 'unknown_invoice_type', message: `Invoice type ${invoiceType} is not in AADE table ${EXPENSE_TABLE_VERSION}` };
  }
  if (entry === 'related') {
    return { ok: false, issue: 'depends_on_related', message: `For invoice type ${invoiceType} the allowed values depend on the related invoices` };
  }
  const categories = allowedCategories(invoiceType);
  if (categories.length === 0) {
    return { ok: false, issue: 'invoice_type_without_expenses', message: `Invoice type ${invoiceType} does not accept an expense classification` };
  }
  if (!categories.includes(category)) {
    return { ok: false, issue: 'category_not_allowed', message: `Invoice type ${invoiceType} does not accept ${category}`, allowedCategories: categories };
  }
  if (!E3_CODE_PATTERN.test(e3Code)) {
    return { ok: false, issue: 'e3_malformed', message: `Malformed E3 code: ${e3Code}` };
  }
  const codes = allowedE3(invoiceType, category) ?? [];
  // No list (a category without E3 code): there is no combination to check
  if (codes.length > 0 && !codes.includes(e3Code)) {
    return { ok: false, issue: 'e3_not_allowed', message: `Invoice type ${invoiceType} with ${category} does not accept ${e3Code}`, allowedE3: codes };
  }
  return { ok: true };
}

/**
 * Why AADE does not accept the classification for that invoice type, or null if it does.
 * For types whose values depend on the related invoices (1.6, 2.4, 5.1) it cannot be checked: accept it only when a
 * person decided it (`manual`), never when a system proposed it.
 */
export function combinationIssue(invoiceType: string, category: string, e3Code: string, manual: boolean): string | null {
  const r = validateExpenseClassification(invoiceType, category, e3Code);
  if (r.ok) return null;
  return r.issue === 'depends_on_related' && manual ? null : r.message;
}

export interface LineVat {
  /** VAT category of the line in myDATA (1 = 24 %, 2 = 13 %… 7 = 0 %, 8 = no VAT). */
  vatCategory: number | null;
  vatAmount: number;
  /** VAT exemption cause, if the line has one. */
  exemptionCause: number | null;
}

/**
 * VAT classification AADE requires on an expense line (error 230 if missing):
 * - `null`: the line takes no VAT classification (no VAT, 0 % or exempt).
 * - `{ type }`: VAT_361 (domestic purchases and expenses) or VAT_362 (investments: fixed assets, category2_7); both
 *   checked against myDATA. The amount of this classification is the line's net value, not the VAT.
 * - `{ unsupported }`: a case this library does not handle (exemption of article 39α).
 * Intra-EU purchases, imports and reverse-charge investments (VAT_363–VAT_366) cannot be inferred from the invoice
 * data alone, so they are not produced here.
 */
export function vatClassification(category: string, line: LineVat): { type: string } | { unsupported: string } | null {
  if (line.exemptionCause !== null) {
    return line.exemptionCause === 16 ? { unsupported: 'Exemption of article 39α of the VAT Code (VAT_366)' } : null;
  }
  // Expenses without the right to deduct VAT: the VAT is part of the expense (see expenseAmount), not classified apart
  if (category === 'category2_5') return null;
  if (line.vatCategory === null || line.vatCategory < 1 || line.vatCategory > 6 || !(line.vatAmount > 0)) return null;
  return { type: category === 'category2_7' ? 'VAT_362' : 'VAT_361' };
}

/**
 * Amount sent in the line's E3 classification. Normally the net value (error 306 if it does not match).
 * In category 2.5 (expenses without the right to deduct VAT) it is net + VAT: the non-deductible VAT is part of the
 * expense (checked against the myDATA test environment).
 */
export function expenseAmount(category: string, net: number, vat: number): number {
  return category === 'category2_5' ? Math.round((net + vat) * 100) / 100 : net;
}

export interface LineForSums {
  /** Net value of the line on the invoice. */
  net: number;
  vat?: number;
  /** Classified amount of that line. */
  classifiedAmount: number;
}
export interface TotalsForSums { totalNetValue?: number; totalVatAmount?: number }

export interface SumsCheck { ok: boolean; errors: string[] }

// One cent of rounding tolerance (the epsilon stops 0.01 failing on floating point)
const TOLERANCE = 0.01 + 1e-9;
const same = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/**
 * Sums must match before sending: each line's classified amount is its net value, and the lines add up to the
 * invoice totals (net and VAT, when the invoice has them). Do not use it for category 2.5 lines (see expenseAmount).
 */
export function validateSums(lines: LineForSums[], totals: TotalsForSums = {}): SumsCheck {
  const errors: string[] = [];
  lines.forEach((l, i) => {
    if (!same(l.classifiedAmount, l.net)) {
      errors.push(`Line ${i + 1}: classified amount ${l.classifiedAmount.toFixed(2)} ≠ net ${l.net.toFixed(2)}`);
    }
  });
  const net = lines.reduce((s, l) => s + l.net, 0);
  if (totals.totalNetValue !== undefined && !same(net, totals.totalNetValue)) {
    errors.push(`Net of the lines ${net.toFixed(2)} ≠ total net ${totals.totalNetValue.toFixed(2)}`);
  }
  if (totals.totalVatAmount !== undefined && lines.every(l => l.vat !== undefined)) {
    const vat = lines.reduce((s, l) => s + (l.vat as number), 0);
    if (!same(vat, totals.totalVatAmount)) errors.push(`VAT of the lines ${vat.toFixed(2)} ≠ total VAT ${totals.totalVatAmount.toFixed(2)}`);
  }
  return { ok: errors.length === 0, errors };
}
