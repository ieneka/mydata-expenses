import { parseStringPromise } from 'xml2js';
import {
  buildExpensesClassificationsXml, parseClassificationResponse, parseExpensesClassifications,
  type ClassificationResult, type InvoiceClassification, type MyDataExpensesClassification,
} from './expenses-classification';

export interface MyDataConfig {
  aadeUserId: string;
  subscriptionKey: string;
  environment: 'production' | 'development';
  /** End of the time budget (epoch ms): on HTTP 429 the client waits and retries while it fits before this moment. */
  deadline?: number;
  /** Maximum wait per response (ms). Without it, a hung AADE blocks the job until the platform kills it. */
  timeoutMs?: number;
  /**
   * ΑΦΜ (VAT number) of the business you act for when the credentials belong to an authorised third party in TAXISnet
   * (e.g. the accountant with their own API user). Sent as `entityVatNumber` on reads and classifications.
   */
  entityVatNumber?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP 401/403: missing headers or the key does not match the user. Treat the connection as broken. */
export class MyDataAuthError extends Error {}

/**
 * AADE error 105: the user is not authorised to act for that ΑΦΜ (no authorisation in TAXISnet, or it was withdrawn).
 * On RequestDocs and RequestTransmittedDocs it arrives with HTTP 200 inside a ResponseDoc; without detecting it you
 * would read 0 invoices and no error. It is a MyDataAuthError: that business's connection should be marked as broken.
 */
export class MyDataNotAuthorizedError extends MyDataAuthError {
  constructor(message: string, public entityVatNumber?: string) {
    super(message);
  }
}

/** Validation error returned in a ResponseDoc to a read (e.g. invalid parameters). */
export class MyDataResponseError extends Error {
  constructor(public code: string, message: string) {
    super(`MyData error ${code}: ${message}`);
  }
}

const NOT_AUTHORIZED_CODE = '105';

/** Persistent HTTP 429 (the test environment allows few calls per window). It is transient: retry later. */
export class MyDataRateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`MyData rate limit: retry in ${Math.round(retryAfterMs / 1000)} s`);
  }
}

/** Maximum wait for a 429 within a single call; beyond that the caller should pause the job. */
const MAX_RATE_LIMIT_WAIT_MS = 12_000;

// Shape as parsed by xml2js with explicitArray: false; fields follow the current XSD
export interface MyDataInvoice {
  uid?: string;
  mark: string;
  cancelledByMark?: string;
  issuer?: { vatNumber?: string; name?: string; country?: string };
  invoiceHeader?: {
    series?: string; aa?: string; issueDate?: string; invoiceType?: string;
    /** MARK of related invoices (e.g. the original of a 5.1 credit note or of a 1.6/2.4 supplementary invoice) */
    correlatedInvoices?: string | string[];
  };
  invoiceDetails?: unknown;
  invoiceSummary?: { totalNetValue?: string; totalVatAmount?: string; totalGrossValue?: string };
  [key: string]: unknown;
}

export interface PageCursor {
  partition: string;
  row: string;
}

export interface DocsQuery {
  mark?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** Resume at a given page (a saved continuationToken) */
  cursor?: PageCursor;
}

/** Cancellation reported in cancelledInvoicesDoc: invoice invoiceMark is no longer valid. */
export interface Cancellation {
  invoiceMark: string;
  cancellationMark: string;
}

export interface DocPage {
  invoices: MyDataInvoice[];
  /** Cancellations included in this page (there can be some with no invoices) */
  cancellations?: Cancellation[];
  /** Cursor this page was requested with (undefined = first page) */
  start?: PageCursor;
  /** Cursor of the next page (undefined = last page) */
  next?: PageCursor;
}

/** Date format of the AADE API: dd/MM/yyyy (UTC calendar). */
export const aadeDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

/** Monthly ranges [start, end] from the month of `from` to the month of `to`, both included (UTC). */
export function monthRanges(from: Date, to: Date): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  while (y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth())) {
    out.push({ start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 0)) });
    if (++m === 12) { m = 0; y++; }
  }
  return out;
}

const toArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export class MyDataClient {
  private baseUrl: string;
  private aadeUserId: string;
  private subscriptionKey: string;
  private deadline?: number;
  private timeoutMs: number;
  private entityVatNumber?: string;

  constructor(config: MyDataConfig) {
    if (config.entityVatNumber !== undefined && !/^\d{9}$/.test(config.entityVatNumber)) {
      throw new Error(`Invalid entity VAT number: ${config.entityVatNumber}`);
    }
    this.entityVatNumber = config.entityVatNumber;
    this.deadline = config.deadline;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.aadeUserId = config.aadeUserId;
    this.subscriptionKey = config.subscriptionKey;
    this.baseUrl = config.environment === 'production'
      ? 'https://mydatapi.aade.gr/myDATA/'
      : 'https://mydataapidev.aade.gr/';
  }

  private getHeaders() {
    return {
      'aade-user-id': this.aadeUserId,
      'ocp-apim-subscription-key': this.subscriptionKey,
      'Content-Type': 'application/xml',
      // No Accept header: with «Accept: application/xml» AADE returns the XML escaped inside a .NET <string>
    };
  }

  private async request(endpoint: string, method: string = 'GET', body?: string, retries = 3): Promise<any> {
    let response: Response | undefined;
    let wait = 0;
    let rateLimited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${this.baseUrl}${endpoint}`, {
          method, headers: this.getHeaders(), body, signal: AbortSignal.timeout(this.timeoutMs),
        });
        // Only transient errors are retried (5xx and 429)
        if (response.ok || (response.status < 500 && response.status !== 429) || attempt >= retries) break;
      } catch (err) {
        // A timeout is not retried: repeating it would multiply the wait while AADE is hung
        if (attempt >= retries || (err instanceof Error && err.name === 'TimeoutError')) throw err;
      }
      // 429: AADE says how long to wait (Retry-After, in seconds); 5xx: exponential backoff
      wait = response?.status === 429
        ? (Number(response.headers?.get('retry-after')) || 10) * 1000 + 250
        : 500 * 2 ** attempt;
      // 429: with a deadline, keep waiting while it fits; without one, a single retry. Then the caller decides
      if (response?.status === 429) {
        const fits = this.deadline !== undefined ? Date.now() + wait < this.deadline : rateLimited === 0;
        rateLimited++;
        if (!fits || wait > MAX_RATE_LIMIT_WAIT_MS) break;
        attempt--; // waits for 429 do not use up the 5xx retries
      }
      await sleep(wait);
    }
    if (!response) throw new Error('MyData API Error: no response');

    if (response.status === 401 || response.status === 403) {
      throw new MyDataAuthError(`MyData auth error: ${response.status}`);
    }
    if (response.status === 429) {
      // Without retries (POST) no wait was computed: use the Retry-After of the response itself
      const retryAfter = (Number(response.headers?.get('retry-after')) || 0) * 1000;
      throw new MyDataRateLimitError(wait || retryAfter || 10_000);
    }
    if (!response.ok) {
      // RequestE3Info/RequestVatInfo answer 400 with the reason in the body (e.g. missing authorisation)
      let detail = '';
      try { detail = await response.text(); } catch { /* unreadable body: generic error */ }
      if (/is not authorized/i.test(detail)) throw new MyDataNotAuthorizedError(detail.trim(), this.entityVatNumber);
      throw new Error(`MyData API Error: ${response.status} - ${response.statusText}`);
    }

    const xml = await response.text();
    // AADE may return an empty body when there are no new documents
    if (!xml) return null;

    const parsed = await parseStringPromise(xml, { explicitArray: false });
    // Response wrapped as text (<string xmlns=".../Serialization/">&lt;?xml…): unwrap and parse again
    if (typeof parsed?.string === 'string' || typeof parsed?.string?._ === 'string') {
      const inner = typeof parsed.string === 'string' ? parsed.string : parsed.string._;
      return parseStringPromise(inner, { explicitArray: false });
    }
    return parsed;
  }

  /**
   * A read that AADE rejects returns HTTP 200 with a ResponseDoc (statusCode + errors) instead of the RequestedDoc.
   * It is turned into an exception so it is not mistaken for «no documents».
   */
  private assertNotErrorDoc(parsed: any) {
    const response = toArray<any>(parsed?.ResponseDoc?.response)[0];
    if (!response) return;
    const errors = toArray<any>(response.errors?.error);
    const first = errors[0];
    const code = String(first?.code ?? '');
    const message = String(first?.message ?? response.statusCode ?? 'Unknown error');
    if (code === NOT_AUTHORIZED_CODE || /is not authorized/i.test(message)) {
      throw new MyDataNotAuthorizedError(message, this.entityVatNumber);
    }
    throw new MyDataResponseError(code || String(response.statusCode ?? ''), message);
  }

  /** Common read parameters: `entityVatNumber` when acting for another business. */
  private readParams() {
    const params = new URLSearchParams();
    if (this.entityVatNumber) params.append('entityVatNumber', this.entityVatNumber);
    return params;
  }

  /**
   * RequestDocs
   * Invoices others issue to the business (expenses), their classifications and cancellations.
   */
  async requestDocs(mark?: string, nextPartitionKey?: string, nextRowKey?: string, dates?: { dateFrom?: Date; dateTo?: Date }) {
    const params = this.readParams();
    if (mark) params.append('mark', mark);
    if (dates?.dateFrom) params.append('dateFrom', aadeDate(dates.dateFrom));
    if (dates?.dateTo) params.append('dateTo', aadeDate(dates.dateTo));
    if (nextPartitionKey) params.append('nextPartitionKey', nextPartitionKey);
    if (nextRowKey) params.append('nextRowKey', nextRowKey);

    const queryString = params.toString();
    const endpoint = queryString ? `RequestDocs?${queryString}` : 'RequestDocs';

    const parsed = await this.request(endpoint, 'GET');
    this.assertNotErrorDoc(parsed);
    return parsed;
  }

  /**
   * RequestTransmittedDocs
   * What the business itself has transmitted: its issued invoices and its classifications (expenses included).
   */
  async requestTransmittedDocs(mark?: string, nextPartitionKey?: string, nextRowKey?: string) {
    const params = this.readParams();
    if (mark) params.append('mark', mark);
    if (nextPartitionKey) params.append('nextPartitionKey', nextPartitionKey);
    if (nextRowKey) params.append('nextRowKey', nextRowKey);
    const queryString = params.toString();
    const parsed = await this.request(queryString ? `RequestTransmittedDocs?${queryString}` : 'RequestTransmittedDocs', 'GET');
    this.assertNotErrorDoc(parsed);
    return parsed;
  }

  /**
   * What the business has transmitted to myDATA, page by page from a MARK: its expense classifications (sent from
   * your software, from the AADE website or by its accountant), its issued invoices and their cancellations.
   * `maxMark`: the highest MARK in the page, to resume the next read from there.
   */
  async *iterateTransmittedClassifications(mark = '0', cursor?: PageCursor): AsyncGenerator<{
    classifications: MyDataExpensesClassification[]; invoices: MyDataInvoice[]; cancellations: Cancellation[];
    maxMark: string; start?: PageCursor; next?: PageCursor;
  }> {
    let start = cursor;
    do {
      const result = await this.requestTransmittedDocs(mark, start?.partition, start?.row);
      const doc = result?.RequestedDoc;
      const partition = doc?.continuationToken?.nextPartitionKey;
      const row = doc?.continuationToken?.nextRowKey;
      const next = partition && row ? { partition, row } : undefined;
      const classifications = parseExpensesClassifications(doc);
      const invoices = toArray<MyDataInvoice>(doc?.invoicesDoc?.invoice).filter(i => i?.mark);
      const cancellations = toArray<Cancellation>(doc?.cancelledInvoicesDoc?.cancelledInvoice).filter(c => c?.invoiceMark);
      const marks = [
        ...classifications.map(c => c.classificationMark),
        ...invoices.map(i => String(i.mark)),
        ...cancellations.map(c => String(c.cancellationMark ?? '')),
      ].filter(m => /^\d+$/.test(m));
      const maxMark = marks.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), mark);
      yield { classifications, invoices, cancellations, maxMark, start, next };
      start = next;
    } while (start);
  }

  /**
   * SendExpensesClassification
   * Sends the expense classification (per line) of one or more invoices. AADE answers 200 with one result per invoice
   * (Success or ValidationError…): the caller decides what to do with each. No automatic retries: repeating a POST
   * after a 5xx error could send it twice.
   */
  async sendExpensesClassification(invoices: InvoiceClassification[]): Promise<ClassificationResult[]> {
    if (invoices.length === 0) return [];
    const entity = this.entityVatNumber;
    const body = buildExpensesClassificationsXml(entity ? invoices.map(i => ({ entityVatNumber: entity, ...i })) : invoices);
    const parsed = await this.request('SendExpensesClassification', 'POST', body, 0);
    return parseClassificationResponse(parsed);
  }

  /**
   * Walks all RequestDocs pages from a MARK following continuationToken and yields the invoices of each page
   * as an array.
   */
  async *iterateDocs(query: string | DocsQuery = '0'): AsyncGenerator<MyDataInvoice[]> {
    for await (const page of this.iterateDocPages(typeof query === 'string' ? { mark: query } : query)) {
      yield page.invoices;
    }
  }

  /**
   * Like iterateDocs, but also yields the cursors of each page so you can save progress and resume in the middle
   * of a long query.
   */
  async *iterateDocPages(query: DocsQuery = {}): AsyncGenerator<DocPage> {
    const { mark = '0', dateFrom, dateTo } = query;
    let start: PageCursor | undefined = query.cursor;
    do {
      const result = await this.requestDocs(mark, start?.partition, start?.row, { dateFrom, dateTo });
      const doc = result?.RequestedDoc;
      const partition = doc?.continuationToken?.nextPartitionKey;
      const row = doc?.continuationToken?.nextRowKey;
      const next = partition && row ? { partition, row } : undefined;
      yield {
        invoices: toArray<MyDataInvoice>(doc?.invoicesDoc?.invoice),
        cancellations: toArray<Cancellation>(doc?.cancelledInvoicesDoc?.cancelledInvoice).filter(c => c?.invoiceMark),
        start, next,
      };
      start = next;
    } while (start);
  }

  /**
   * ΑΦΜ of the credentials' owner, taken from the first page of their documents: counterpart of the expenses
   * (RequestDocs since `since`) and issuer of what was transmitted. Empty if there are no documents yet.
   */
  async ownVatNumbers(since: Date): Promise<Set<string>> {
    const afms = new Set<string>();
    const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) afms.add(v.trim()); };
    const received = await this.requestDocs('0', undefined, undefined, { dateFrom: since, dateTo: new Date() });
    for (const inv of toArray<MyDataInvoice>(received?.RequestedDoc?.invoicesDoc?.invoice)) {
      add((inv.counterpart as { vatNumber?: unknown } | undefined)?.vatNumber);
    }
    if (afms.size) return afms;
    const sent = await this.requestTransmittedDocs('0');
    for (const inv of toArray<MyDataInvoice>(sent?.RequestedDoc?.invoicesDoc?.invoice)) add(inv.issuer?.vatNumber);
    return afms;
  }
}
