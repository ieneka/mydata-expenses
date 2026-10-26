import { MyDataClient, MyDataRateLimitError } from './client';
import { parseStringPromise } from 'xml2js';
import { buildExpensesClassificationsXml, describeErrors, parseClassificationResponse, parseExpensesClassifications } from './expenses-classification';

// RequestTransmittedDocs response with the shape AADE's test environment returns: «ecls:» prefix
const transmitted = (items: string) => `<?xml version="1.0" encoding="utf-8"?>
<RequestedDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0" xmlns:ecls="https://www.aade.gr/myDATA/expensesClassificaton/v1.0">
  <expensesClassificationsDoc>${items}</expensesClassificationsDoc>
</RequestedDoc>`;
const item = (inv: string, cls: string, body: string, mode = 0, post = 0) => `
    <ecls:expensesInvoiceClassification>
      <ecls:invoiceMark>${inv}</ecls:invoiceMark><ecls:classificationMark>${cls}</ecls:classificationMark>
      <ecls:entityVatNumber>123456783</ecls:entityVatNumber><ecls:transactionMode>${mode}</ecls:transactionMode>
      <ecls:classificationPostMode>${post}</ecls:classificationPostMode>${body}
    </ecls:expensesInvoiceClassification>`;

describe('parseExpensesClassifications', () => {
  const parse = async (xml: string) => parseExpensesClassifications((await parseStringPromise(xml, { explicitArray: false })).RequestedDoc);

  it('reads several prefixed classifications, with E3 and VAT per line', async () => {
    const out = await parse(transmitted(
      item('400000000000101', '400000000000201', `<ecls:invoicesExpensesClassificationDetails><ecls:lineNumber>1</ecls:lineNumber>
        <ecls:expensesClassificationDetailData><ecls:classificationType>E3_585_016</ecls:classificationType><ecls:classificationCategory>category2_3</ecls:classificationCategory><ecls:amount>45.00</ecls:amount></ecls:expensesClassificationDetailData>
      </ecls:invoicesExpensesClassificationDetails>`)
      + item('400000000000102', '400000000000202', `<ecls:invoicesExpensesClassificationDetails><ecls:lineNumber>1</ecls:lineNumber>
        <ecls:expensesClassificationDetailData><ecls:classificationType>E3_882_001</ecls:classificationType><ecls:classificationCategory>category2_7</ecls:classificationCategory><ecls:amount>50.00</ecls:amount></ecls:expensesClassificationDetailData>
        <ecls:expensesClassificationDetailData><ecls:classificationType>VAT_362</ecls:classificationType><ecls:amount>50.00</ecls:amount></ecls:expensesClassificationDetailData>
      </ecls:invoicesExpensesClassificationDetails>`),
    ));
    expect(out).toEqual([
      { invoiceMark: '400000000000101', classificationMark: '400000000000201', transactionMode: 0, postMode: 0,
        lines: [{ lineNumber: 1, e3: [{ type: 'E3_585_016', category: 'category2_3', amount: 45 }], vat: [] }] },
      { invoiceMark: '400000000000102', classificationMark: '400000000000202', transactionMode: 0, postMode: 0,
        lines: [{ lineNumber: 1, e3: [{ type: 'E3_882_001', category: 'category2_7', amount: 50 }], vat: [{ type: 'VAT_362', amount: 50 }] }] },
    ]);
  });

  it('a single classification (no array) and an invoice rejected by the recipient, without lines', async () => {
    const out = await parse(transmitted(item('5', '9', '', 1)));
    expect(out).toEqual([{ invoiceMark: '5', classificationMark: '9', transactionMode: 1, postMode: 0, lines: [] }]);
  });

  it('without classifications returns an empty list', async () => {
    expect(await parse('<RequestedDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0"></RequestedDoc>')).toEqual([]);
  });
});

// Mock fetch: no real network calls
global.fetch = jest.fn();

const invoices = [
  { invoiceMark: '400001', lines: [{ lineNumber: 1, classificationType: 'E3_585_016', classificationCategory: 'category2_4', amount: 100 }] },
  {
    invoiceMark: '400002',
    lines: [
      { lineNumber: 1, classificationType: 'E3_102_001', classificationCategory: 'category2_1', amount: 50.5 },
      { lineNumber: 2, classificationType: 'E3_585_004', classificationCategory: 'category2_4', amount: 12.345 },
    ],
  },
];

describe('buildExpensesClassificationsXml', () => {
  const xml = buildExpensesClassificationsXml(invoices);

  it('uses the official namespace and one element per invoice', () => {
    expect(xml).toContain('<ExpensesClassificationsDoc xmlns="https://www.aade.gr/myDATA/expensesClassificaton/v1.0"');
    expect(xml.match(/<expensesInvoiceClassification>/g)).toHaveLength(2);
    expect(xml.match(/<invoicesExpensesClassificationDetails>/g)).toHaveLength(3);
  });

  it('follows the XSD order in each classification and has no VAT fields (per-line method)', () => {
    const detail = xml.match(/<expensesClassificationDetailData>[\s\S]*?<\/expensesClassificationDetailData>/)![0];
    const order = ['classificationType', 'classificationCategory', 'amount'].map(t => detail.indexOf(`<${t}>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(i => i > 0)).toBe(true);
    expect(xml).not.toMatch(/vatAmount|vatCategory|vatExemptionCategory|classificationPostMode|transactionMode/);
  });

  it('amounts have two decimals', () => {
    expect(xml).toContain('<amount>100.00</amount>');
    expect(xml).toContain('<amount>50.50</amount>');
    expect(xml).toContain('<amount>12.35</amount>');
  });

  it('adds the line VAT classification, without category, after the E3 one', () => {
    const out = buildExpensesClassificationsXml([{
      invoiceMark: '7',
      lines: [{ lineNumber: 1, classificationType: 'E3_585_016', classificationCategory: 'category2_4', amount: 100, vat: { classificationType: 'VAT_361', amount: 100 } }],
    }]);
    const details = out.match(/<expensesClassificationDetailData>[\s\S]*?<\/expensesClassificationDetailData>/g)!;
    expect(details).toHaveLength(2);
    expect(details[0]).toContain('E3_585_016');
    expect(details[1]).toContain('<classificationType>VAT_361</classificationType>');
    expect(details[1]).not.toContain('classificationCategory');
  });

  it('rejects a non-numeric MARK and an invoice without lines', () => {
    expect(() => buildExpensesClassificationsXml([{ invoiceMark: '1</invoiceMark><x/>', lines: invoices[0].lines }])).toThrow('Invalid invoice mark');
    expect(() => buildExpensesClassificationsXml([{ invoiceMark: '1', lines: [] }])).toThrow('no lines');
  });

  it('puts entityVatNumber after invoiceMark (XSD order) and rejects an invalid one', () => {
    const out = buildExpensesClassificationsXml([{ invoiceMark: '5', entityVatNumber: '123456783', lines: invoices[0].lines }]);
    expect(out.indexOf('<entityVatNumber>123456783</entityVatNumber>')).toBeGreaterThan(out.indexOf('</invoiceMark>'));
    expect(out.indexOf('<entityVatNumber>')).toBeLessThan(out.indexOf('<invoicesExpensesClassificationDetails>'));
    expect(xml).not.toContain('entityVatNumber');
    expect(() => buildExpensesClassificationsXml([{ invoiceMark: '5', entityVatNumber: '1<x/>', lines: invoices[0].lines }]))
      .toThrow('Invalid entity VAT number');
  });

  it('escapes text', () => {
    const out = buildExpensesClassificationsXml([{ invoiceMark: '5', lines: [{ lineNumber: 1, classificationType: 'E3<&>', classificationCategory: 'c"', amount: 1 }] }]);
    expect(out).toContain('E3&lt;&amp;&gt;');
    expect(out).toContain('c&quot;');
  });
});

describe('parseClassificationResponse', () => {
  it('reads a successful result with its classification MARK', () => {
    const r = parseClassificationResponse({ ResponseDoc: { response: { index: '1', invoiceMark: '400001', classificationMark: '900001', statusCode: 'Success' } } });
    expect(r).toEqual([{ index: 1, statusCode: 'Success', invoiceMark: '400001', classificationMark: '900001', errors: [] }]);
  });

  it('reads several invoices, with one error and with several errors', () => {
    const r = parseClassificationResponse({
      ResponseDoc: {
        response: [
          { index: '1', invoiceMark: '1', classificationMark: '9', statusCode: 'Success' },
          { index: '2', statusCode: 'ValidationError', errors: { error: { code: '306', message: 'Sum' } } },
          { index: '3', statusCode: 'ValidationError', errors: { error: [{ code: '307', message: 'Type' }, { code: '313', message: 'Combination' }] } },
        ],
      },
    });
    expect(r.map(x => x.statusCode)).toEqual(['Success', 'ValidationError', 'ValidationError']);
    expect(r[1].errors).toEqual([{ code: '306', message: 'Sum' }]);
    expect(r[2].errors).toHaveLength(2);
  });

  it('an empty or odd response breaks nothing', () => {
    expect(parseClassificationResponse(null)).toEqual([]);
    expect(parseClassificationResponse({ other: 1 })).toEqual([]);
  });

  it('describeErrors joins codes and messages', () => {
    expect(describeErrors([{ code: '306', message: 'Sum' }, { code: '313', message: 'Combination' }])).toBe('306: Sum · 313: Combination');
    expect(describeErrors([], 'TechnicalError')).toBe('myDATA: TechnicalError');
  });
});

describe('MyDataClient.sendExpensesClassification', () => {
  const okXml = `<?xml version="1.0" encoding="utf-8"?><ResponseDoc><response><index>1</index><invoiceMark>400001</invoiceMark><classificationMark>900001</classificationMark><statusCode>Success</statusCode></response></ResponseDoc>`;
  const mk = () => new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development' });
  const reply = (status: number, body = '', headers: Record<string, string> = {}) =>
    ({ ok: status >= 200 && status < 300, status, statusText: '', text: async () => body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

  beforeEach(() => { (global.fetch as jest.Mock).mockReset(); });

  it('POSTs to the test URL with the headers and the XML, and returns the result', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(reply(200, okXml));
    const r = await mk().sendExpensesClassification([invoices[0]]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://mydataapidev.aade.gr/SendExpensesClassification');
    expect(init.method).toBe('POST');
    expect(init.headers['aade-user-id']).toBe('u');
    expect(init.body).toContain('<invoiceMark>400001</invoiceMark>');
    expect(r[0]).toMatchObject({ statusCode: 'Success', classificationMark: '900001' });
  });

  it('without invoices does not call AADE', async () => {
    expect(await mk().sendExpensesClassification([])).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a 5xx error is not retried (it could send twice)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(reply(500));
    await expect(mk().sendExpensesClassification([invoices[0]])).rejects.toThrow('500');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('a 429 is reported with AADE’s Retry-After', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(reply(429, '', { 'retry-after': '30' }));
    const err = await mk().sendExpensesClassification([invoices[0]]).catch(e => e);
    expect(err).toBeInstanceOf(MyDataRateLimitError);
    expect(err.retryAfterMs).toBe(30_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
