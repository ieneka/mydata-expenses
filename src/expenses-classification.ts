/**
 * SendExpensesClassification: input XML and response.
 * Official schemas v2.0.2: expensesClassification-v2.0.2.xsd and response-v2.0.2.xsd (AADE).
 * Uses the per-line method (no postPerInvoice): each invoice line carries its E3 classification and all lines of an
 * invoice go in the same request (AADE error 304: «all lines or none»).
 */

/** Official namespace (with the «Classificaton» typo exactly as AADE publishes it). */
export const EXPENSES_CLASSIFICATION_NS = 'https://www.aade.gr/myDATA/expensesClassificaton/v1.0';

export interface LineClassification {
  /** Line number of the invoice in myDATA. */
  lineNumber: number;
  /** E3 code, e.g. E3_585_016. */
  classificationType: string;
  /** Category, e.g. category2_4. */
  classificationCategory: string;
  /** Classified amount: the line's net value (error 306 if the sum does not match). See expenseAmount for 2.5. */
  amount: number;
  /**
   * VAT classification of the line (VAT_361…VAT_366): AADE requires it when the line carries VAT (error 230).
   * It goes without a category (error 315). See vatClassification.
   */
  vat?: { classificationType: string; amount: number };
}

export interface InvoiceClassification {
  /** MARK of the invoice being classified. */
  invoiceMark: string;
  /** ΑΦΜ of the business being classified for, when an authorised third party sends (e.g. the accountant). */
  entityVatNumber?: string;
  lines: LineClassification[];
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** POST body: one `expensesInvoiceClassification` per invoice. */
export function buildExpensesClassificationsXml(invoices: InvoiceClassification[]): string {
  const body = invoices.map(inv => {
    if (!/^\d+$/.test(inv.invoiceMark)) throw new Error(`Invalid invoice mark: ${inv.invoiceMark}`);
    if (inv.lines.length === 0) throw new Error(`Invoice ${inv.invoiceMark} has no lines to classify`);
    if (inv.entityVatNumber !== undefined && !/^\d{9}$/.test(inv.entityVatNumber)) {
      throw new Error(`Invalid entity VAT number: ${inv.entityVatNumber}`);
    }
    // XSD order: invoiceMark, classificationMark, entityVatNumber, details
    const entity = inv.entityVatNumber ? `    <entityVatNumber>${inv.entityVatNumber}</entityVatNumber>\n` : '';
    const lines = inv.lines.map(l => [
      '      <invoicesExpensesClassificationDetails>',
      `        <lineNumber>${Math.trunc(l.lineNumber)}</lineNumber>`,
      '        <expensesClassificationDetailData>',
      `          <classificationType>${escapeXml(l.classificationType)}</classificationType>`,
      `          <classificationCategory>${escapeXml(l.classificationCategory)}</classificationCategory>`,
      `          <amount>${l.amount.toFixed(2)}</amount>`,
      '        </expensesClassificationDetailData>',
      ...(l.vat ? [
        '        <expensesClassificationDetailData>',
        `          <classificationType>${escapeXml(l.vat.classificationType)}</classificationType>`,
        `          <amount>${l.vat.amount.toFixed(2)}</amount>`,
        '        </expensesClassificationDetailData>',
      ] : []),
      '      </invoicesExpensesClassificationDetails>',
    ].join('\n')).join('\n');
    return `  <expensesInvoiceClassification>\n    <invoiceMark>${inv.invoiceMark}</invoiceMark>\n${entity}${lines}\n  </expensesInvoiceClassification>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ExpensesClassificationsDoc xmlns="${EXPENSES_CLASSIFICATION_NS}" xmlns:ecls="${EXPENSES_CLASSIFICATION_NS}">\n${body}\n</ExpensesClassificationsDoc>\n`;
}

export interface ClassificationError { code: string; message: string }

/** Result of one invoice in the response (`ResponseDoc/response`). */
export interface ClassificationResult {
  /** Position (starting at 1) of the invoice in the request. */
  index: number;
  /** Success, ValidationError, TechnicalError or XMLSyntaxError. */
  statusCode: string;
  invoiceMark?: string;
  /** MARK of the classification received; only when statusCode = Success. */
  classificationMark?: string;
  errors: ClassificationError[];
}

const toArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | undefined => {
  const s = typeof v === 'object' && v !== null ? (v as { _?: unknown })._ : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
};

/** Normalises the `ResponseDoc` already parsed with xml2js (explicitArray: false). */
export function parseClassificationResponse(parsed: unknown): ClassificationResult[] {
  const doc = (parsed as { ResponseDoc?: { response?: unknown } } | null)?.ResponseDoc;
  return toArray(doc?.response as Record<string, unknown> | Record<string, unknown>[] | undefined).map((r, i) => ({
    index: Number(text(r.index)) || i + 1,
    statusCode: text(r.statusCode) ?? 'Unknown',
    invoiceMark: text(r.invoiceMark),
    classificationMark: text(r.classificationMark),
    errors: toArray((r.errors as { error?: unknown } | undefined)?.error as Record<string, unknown> | Record<string, unknown>[] | undefined)
      .map(e => ({ code: text(e.code) ?? '', message: text(e.message) ?? '' })),
  }));
}

/** Expense classification as myDATA holds it (read with RequestTransmittedDocs: what the business itself sent). */
export interface MyDataExpensesClassification {
  invoiceMark: string;
  /** MARK of this classification: if an invoice has several, the highest wins (the latest replaces the previous ones). */
  classificationMark: string;
  /** 0: normal classification; 1: invoice rejected by the recipient; 2: deviation in the amounts. */
  transactionMode: number;
  /** 0: per line; 1: per invoice (postPerInvoice: the line number is symbolic). */
  postMode: number;
  /** E3 (with category) and VAT (without category) classification of each line. */
  lines: { lineNumber: number; e3: { type: string; category: string; amount: number }[]; vat: { type: string; amount: number }[] }[];
}

/** Strips the namespace prefix from keys (`ecls:invoiceMark` → `invoiceMark`) left by xml2js. */
function stripPrefixes(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripPrefixes);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.replace(/^[^:$]+:/, ''), stripPrefixes(x)]));
}

/** Expense classifications of an already parsed `RequestedDoc` (RequestTransmittedDocs or RequestDocs). */
export function parseExpensesClassifications(requestedDoc: unknown): MyDataExpensesClassification[] {
  const doc = stripPrefixes(requestedDoc) as { expensesClassificationsDoc?: unknown } | null;
  const list = (doc?.expensesClassificationsDoc as { expensesInvoiceClassification?: unknown } | undefined)?.expensesInvoiceClassification
    ?? doc?.expensesClassificationsDoc;
  return toArray(list as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .filter(c => text(c.invoiceMark) && text(c.classificationMark))
    .map(c => ({
      invoiceMark: text(c.invoiceMark)!,
      classificationMark: text(c.classificationMark)!,
      transactionMode: Number(text(c.transactionMode) ?? 0) || 0,
      postMode: Number(text(c.classificationPostMode) ?? 0) || 0,
      lines: toArray(c.invoicesExpensesClassificationDetails as Record<string, unknown> | Record<string, unknown>[] | undefined).map(d => {
        const data = toArray(d.expensesClassificationDetailData as Record<string, unknown> | Record<string, unknown>[] | undefined);
        const amount = (x: Record<string, unknown>) => Number(text(x.amount) ?? 0);
        return {
          lineNumber: Number(text(d.lineNumber) ?? 0),
          e3: data.filter(x => text(x.classificationCategory)).map(x => ({ type: text(x.classificationType) ?? '', category: text(x.classificationCategory)!, amount: amount(x) })),
          vat: data.filter(x => !text(x.classificationCategory) && text(x.classificationType)).map(x => ({ type: text(x.classificationType)!, amount: amount(x) })),
        };
      }),
    }));
}

/** Readable reason for a rejection, to store it and show it to the user. */
export function describeErrors(errors: ClassificationError[], statusCode?: string): string {
  if (errors.length === 0) return statusCode ? `myDATA: ${statusCode}` : 'myDATA: response without details';
  return errors.map(e => (e.code ? `${e.code}: ${e.message}` : e.message)).join(' · ').slice(0, 1000);
}
