import { MyDataClient, MyDataAuthError, MyDataNotAuthorizedError, MyDataRateLimitError, MyDataResponseError, aadeDate, monthRanges } from './client';

// Mock global fetch: no real network calls
global.fetch = jest.fn();

const mockXmlResponse = `<?xml version="1.0" encoding="utf-8"?>
<RequestedDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0">
    <continuationToken>
        <nextPartitionKey>Part1</nextPartitionKey>
        <nextRowKey>Row1</nextRowKey>
    </continuationToken>
    <invoicesDoc>
        <invoice>
            <uid>1234567890123456789012345678901234567890</uid>
            <mark>123456789</mark>
            <issuer>
                <vatNumber>999999999</vatNumber>
                <country>GR</country>
            </issuer>
            <invoiceHeader>
                <series>A</series>
                <aa>1</aa>
                <issueDate>2026-10-01</issueDate>
                <invoiceType>1.1</invoiceType>
                <currency>EUR</currency>
            </invoiceHeader>
            <paymentMethods>
                <paymentMethodDetails>
                    <type>5</type>
                    <amount>124.00</amount>
                </paymentMethodDetails>
            </paymentMethods>
            <invoiceDetails>
                <lineNumber>1</lineNumber>
                <netValue>100.00</netValue>
                <vatCategory>1</vatCategory>
                <vatAmount>24.00</vatAmount>
            </invoiceDetails>
        </invoice>
    </invoicesDoc>
</RequestedDoc>`;

describe('MyDataClient', () => {
  let client: MyDataClient;

  beforeEach(() => {
    client = new MyDataClient({ aadeUserId: 'test-user', subscriptionKey: 'test-key', environment: 'development' });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => mockXmlResponse });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('parses a RequestDocs response', async () => {
    const result = await client.requestDocs();
    expect(global.fetch).toHaveBeenCalledWith('https://mydataapidev.aade.gr/RequestDocs', expect.any(Object));
    const requestedDoc = result.RequestedDoc;
    expect(requestedDoc.continuationToken.nextPartitionKey).toBe('Part1');
    expect(requestedDoc.invoicesDoc.invoice.mark).toBe('123456789');
    expect(requestedDoc.invoicesDoc.invoice.issuer.vatNumber).toBe('999999999');
    expect(requestedDoc.invoicesDoc.invoice.invoiceDetails.netValue).toBe('100.00');
  });

  it('uses the production URL in production', async () => {
    const prod = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'production' });
    await prod.requestDocs();
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://mydatapi.aade.gr/myDATA/RequestDocs');
  });
});

describe('MyDataClient.iterateDocs', () => {
  const lastPage = `<RequestedDoc><invoicesDoc><invoice><mark>2</mark></invoice><invoice><mark>3</mark></invoice></invoicesDoc></RequestedDoc>`;
  const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development' });

  afterEach(() => jest.resetAllMocks());

  it('follows the continuationToken until the last page', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => mockXmlResponse })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => lastPage });
    const pages: string[][] = [];
    for await (const page of client.iterateDocs('0')) pages.push(page.map(i => i.mark));
    expect(pages).toEqual([['123456789'], ['2', '3']]);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('nextPartitionKey=Part1&nextRowKey=Row1');
  });

  it('on 429 waits Retry-After once and then throws MyDataRateLimitError', async () => {
    jest.useFakeTimers();
    const tooMany = { ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: () => '2' }, text: async () => '' };
    (global.fetch as jest.Mock).mockResolvedValue(tooMany);
    const done = expect(client.requestDocs('0')).rejects.toBeInstanceOf(MyDataRateLimitError);
    await jest.advanceTimersByTimeAsync(2_250);
    await done;
    expect(global.fetch).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('on 429 retries after Retry-After and continues if AADE answers', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '1' }, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => lastPage });
    const result = client.requestDocs('0');
    await jest.advanceTimersByTimeAsync(1_250);
    expect((await result).RequestedDoc.invoicesDoc.invoice).toHaveLength(2);
    jest.useRealTimers();
  });

  it('with a deadline, keeps waiting on 429 while it fits before the limit', async () => {
    jest.useFakeTimers();
    const limited = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development', deadline: Date.now() + 8_000 });
    const tooMany = { ok: false, status: 429, headers: { get: () => '2' }, text: async () => '' };
    (global.fetch as jest.Mock).mockResolvedValue(tooMany);
    const done = expect(limited.requestDocs('0')).rejects.toBeInstanceOf(MyDataRateLimitError);
    await jest.advanceTimersByTimeAsync(10_000);
    await done;
    // 2.25 s waits: 3 fit before 8 s → 4 calls
    expect(global.fetch).toHaveBeenCalledTimes(4);
    jest.useRealTimers();
  });

  it('unwraps the response when AADE returns it escaped inside <string>', async () => {
    const escaped = lastPage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const wrapped = `<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">${escaped}</string>`;
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, text: async () => wrapped });
    const pages: string[][] = [];
    for await (const page of client.iterateDocs('0')) pages.push(page.map(i => i.mark));
    expect(pages).toEqual([['2', '3']]);
  });

  it('does not send the Accept header (it causes the wrapped response)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, text: async () => lastPage });
    await client.requestDocs('0');
    expect(Object.keys((global.fetch as jest.Mock).mock.calls[0][1].headers)).not.toContain('Accept');
  });

  it('throws MyDataAuthError on 401 without retrying', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' });
    await expect(client.requestDocs('0')).rejects.toBeInstanceOf(MyDataAuthError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('every request has a timeout and is not retried when it expires', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    (global.fetch as jest.Mock).mockRejectedValue(timeout);
    await expect(client.requestDocs('0')).rejects.toBe(timeout);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('MyDataClient.ownVatNumbers', () => {
  const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development' });
  const ok = (xml: string) => ({ ok: true, status: 200, text: async () => xml });
  afterEach(() => jest.resetAllMocks());

  it('takes the counterpart ΑΦΜ of the expenses', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok(
      `<RequestedDoc><invoicesDoc><invoice><mark>1</mark><issuer><vatNumber>111111111</vatNumber></issuer>`
      + `<counterpart><vatNumber>123456783</vatNumber></counterpart></invoice></invoicesDoc></RequestedDoc>`,
    ));
    expect([...await client.ownVatNumbers(new Date('2026-01-01'))]).toEqual(['123456783']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('without expenses, takes the issuer ΑΦΜ of what was transmitted; without documents, empty', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(ok('<RequestedDoc></RequestedDoc>'))
      .mockResolvedValueOnce(ok(`<RequestedDoc><invoicesDoc><invoice><mark>2</mark><issuer><vatNumber>123456783</vatNumber></issuer></invoice></invoicesDoc></RequestedDoc>`))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok(''));
    expect([...await client.ownVatNumbers(new Date('2026-01-01'))]).toEqual(['123456783']);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('RequestTransmittedDocs');
    expect((await client.ownVatNumbers(new Date('2026-01-01'))).size).toBe(0);
  });
});

describe('date queries', () => {
  afterEach(() => jest.resetAllMocks());

  it('formats dates as dd/MM/yyyy', () => {
    expect(aadeDate(new Date(Date.UTC(2026, 0, 5)))).toBe('05/01/2026');
  });

  it('splits a period into monthly ranges with the right last day', () => {
    const r = monthRanges(new Date(Date.UTC(2025, 10, 15)), new Date(Date.UTC(2026, 1, 3)));
    expect(r.map(x => `${aadeDate(x.start)}-${aadeDate(x.end)}`)).toEqual([
      '01/11/2025-30/11/2025', '01/12/2025-31/12/2025', '01/01/2026-31/01/2026', '01/02/2026-28/02/2026',
    ]);
  });

  it('sends dateFrom and dateTo to RequestDocs', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, text: async () => '<RequestedDoc></RequestedDoc>' });
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development' });
    for await (const page of client.iterateDocs({ dateFrom: new Date(Date.UTC(2026, 0, 1)), dateTo: new Date(Date.UTC(2026, 0, 31)) })) {
      expect(page).toEqual([]);
    }
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('mark=0&dateFrom=01%2F01%2F2026&dateTo=31%2F01%2F2026');
  });
});

describe('acting for another business (entityVatNumber)', () => {
  const ok = (xml: string) => ({ ok: true, status: 200, text: async () => xml });
  // Shape of AADE's test environment answer to RequestDocs for an ΑΦΜ that has not authorised the user
  const notAuthorized = `<?xml version="1.0" encoding="utf-8"?>
<ResponseDoc xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://www.aade.gr/myDATA/invoice/v1.0">
  <response>
    <statusCode>ValidationError</statusCode>
    <errors><error><message>User VAT number 111111111 is not authorized to execute this method for VAT number 123456783</message><code>105</code></error></errors>
  </response>
</ResponseDoc>`;
  afterEach(() => jest.resetAllMocks());

  it('adds entityVatNumber to RequestDocs and RequestTransmittedDocs', async () => {
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development', entityVatNumber: '123456783' });
    (global.fetch as jest.Mock).mockResolvedValue(ok('<RequestedDoc></RequestedDoc>'));
    await client.requestDocs('0');
    await client.requestTransmittedDocs('0');
    const calls = (global.fetch as jest.Mock).mock.calls.map(c => c[0] as string);
    expect(calls[0]).toContain('RequestDocs?entityVatNumber=123456783&mark=0');
    expect(calls[1]).toContain('RequestTransmittedDocs?entityVatNumber=123456783&mark=0');
  });

  it('without entityVatNumber the query does not change', async () => {
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development' });
    (global.fetch as jest.Mock).mockResolvedValue(ok('<RequestedDoc></RequestedDoc>'));
    await client.requestDocs('0');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).not.toContain('entityVatNumber');
  });

  it('rejects an ΑΦΜ with an invalid format', () => {
    expect(() => new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development', entityVatNumber: '12&x=1' }))
      .toThrow('Invalid entity VAT number');
  });

  it('missing authorisation (HTTP 200 with ResponseDoc) throws MyDataNotAuthorizedError, which is a MyDataAuthError', async () => {
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development', entityVatNumber: '123456783' });
    (global.fetch as jest.Mock).mockResolvedValue(ok(notAuthorized));
    const err = await client.requestDocs('0').catch(e => e);
    expect(err).toBeInstanceOf(MyDataNotAuthorizedError);
    expect(err).toBeInstanceOf(MyDataAuthError);
    expect(err.entityVatNumber).toBe('123456783');
    await expect(client.requestTransmittedDocs('0')).rejects.toBeInstanceOf(MyDataNotAuthorizedError);
    // Walking the pages does not silently return «0 invoices» either
    await expect(client.iterateDocs('0').next()).rejects.toBeInstanceOf(MyDataNotAuthorizedError);
  });

  it('another validation error on a read throws MyDataResponseError with its code', async () => {
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development' });
    (global.fetch as jest.Mock).mockResolvedValue(ok(
      '<ResponseDoc><response><statusCode>ValidationError</statusCode><errors><error><message>Invalid date</message><code>101</code></error></errors></response></ResponseDoc>',
    ));
    const err = await client.requestDocs('0').catch(e => e);
    expect(err).toBeInstanceOf(MyDataResponseError);
    expect(err.code).toBe('101');
  });

  it('a 400 with «is not authorized» in the body is also MyDataNotAuthorizedError', async () => {
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development', entityVatNumber: '123456783' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false, status: 400, statusText: 'Bad Request',
      text: async () => 'User VAT number 111111111 is not authorized to execute this method for VAT number 123456783',
    });
    await expect(client.requestDocs('0')).rejects.toBeInstanceOf(MyDataNotAuthorizedError);
  });

  it('classifications carry the business entityVatNumber', async () => {
    const client = new MyDataClient({ aadeUserId: 'u', subscriptionKey: 'k', environment: 'development', entityVatNumber: '123456783' });
    (global.fetch as jest.Mock).mockResolvedValue(ok('<ResponseDoc><response><index>1</index><invoiceMark>5</invoiceMark><classificationMark>9</classificationMark><statusCode>Success</statusCode></response></ResponseDoc>'));
    await client.sendExpensesClassification([{ invoiceMark: '5', lines: [{ lineNumber: 1, classificationType: 'E3_102_001', classificationCategory: 'category2_1', amount: 10 }] }]);
    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as string;
    expect(body).toContain('<invoiceMark>5</invoiceMark>\n    <entityVatNumber>123456783</entityVatNumber>\n');
  });
});
