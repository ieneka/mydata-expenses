# mydata-expenses

Expense classification for **AADE myDATA** (Greece), in TypeScript:

- read the invoices a business **receives** (`RequestDocs`) and what it has **transmitted** (`RequestTransmittedDocs`),
  page by page, also as an accountant acting for clients (`entityVatNumber`);
- check a classification against **AADE's official table** of invoice type × category × E3 code (v2.0.2) before
  sending it;
- send **`SendExpensesClassification`** per line, with the rules AADE enforces but the XSD does not document.

It does one thing: expense classification. To issue invoices (`SendInvoices`), use a general myDATA client.

> Χαρακτηρισμός εξόδων στο myDATA της ΑΑΔΕ: ανάγνωση τιμολογίων αγορών, έλεγχος συνδυασμών κατηγορίας και κωδικού Ε3
> και αποστολή με `SendExpensesClassification`.

## Install

```bash
npm install mydata-expenses
```

Node.js 18.17 or later (it uses the built-in `fetch`). One dependency: `xml2js`.

## Example

```ts
import { MyDataClient, validateExpenseClassification, vatClassification } from 'mydata-expenses';

const client = new MyDataClient({
  aadeUserId: process.env.AADE_USER_ID!,
  subscriptionKey: process.env.AADE_SUBSCRIPTION_KEY!,
  environment: 'development', // https://mydataapidev.aade.gr/ — use 'production' only with real credentials
  // entityVatNumber: '123456783', // when an accountant acts for a client authorised in TAXISnet
});

// 1. Read received invoices (expenses), following the continuationToken
for await (const invoices of client.iterateDocs({ dateFrom: new Date('2026-10-01'), dateTo: new Date('2026-10-31') })) {
  for (const invoice of invoices) console.log(invoice.mark, invoice.invoiceHeader?.invoiceType);
}

// 2. Check the combination before sending it
const check = validateExpenseClassification('1.1', 'category2_4', 'E3_585_016');
if (!check.ok) throw new Error(check.message);

// 3. Send it: every line of the invoice in the same request, with its VAT classification
const vat = vatClassification('category2_4', { vatCategory: 1, vatAmount: 24, exemptionCause: null });
const [result] = await client.sendExpensesClassification([{
  invoiceMark: '400000000000101',
  lines: [{
    lineNumber: 1,
    classificationType: 'E3_585_016',
    classificationCategory: 'category2_4',
    amount: 100,
    vat: vat && 'type' in vat ? { classificationType: vat.type, amount: 100 } : undefined,
  }],
}]);
console.log(result.statusCode, result.classificationMark ?? result.errors);
```

## What AADE does not document (and this library handles)

Learned against AADE's test environment; each one is covered by a test.

| Rule | What happens otherwise |
|---|---|
| All lines of an invoice go in the same request | Error 304 |
| A line with VAT needs a VAT classification (`VAT_361` for domestic purchases and expenses, `VAT_362` for fixed assets, category 2.7), and its amount is the line's **net** value, not the VAT | Error 230 |
| The VAT classification goes **without** a category | Error 315 |
| The E3 amount is the line's net value… | Error 306 |
| …except in category 2.5 (no right to deduct VAT): the amount is net + VAT and there is no VAT classification | Error 306 / 230 |
| Sending again replaces the previous classification: the highest `classificationMark` wins | Duplicates when reading back |
| A read for a business that has not authorised you returns **HTTP 200** with error 105 inside a `ResponseDoc` | You read 0 invoices and no error (`MyDataNotAuthorizedError` here) |
| With `Accept: application/xml`, AADE returns the XML escaped inside a .NET `<string>` | Unparseable response (no `Accept` header here, and it is unwrapped anyway) |
| The namespace is `expensesClassificaton` (sic) | Rejected XML |
| The test environment answers 429 after a few calls | Failed jobs (`Retry-After` is honoured; `deadline` lets you set a time budget) |
| Types 1.6, 2.4 and 5.1 take the values of the related invoices | They cannot be checked against the table: `combinationIssue(..., manual)` only accepts them when a person decided |

POSTs are never retried automatically: repeating `SendExpensesClassification` after a 5xx could send it twice.

## API

**Client** — `MyDataClient`: `requestDocs`, `requestTransmittedDocs`, `iterateDocs`, `iterateDocPages` (with resumable
cursors), `iterateTransmittedClassifications`, `sendExpensesClassification`, `ownVatNumbers`. Errors:
`MyDataAuthError`, `MyDataNotAuthorizedError`, `MyDataResponseError`, `MyDataRateLimitError`.

**Validation** — `validateExpenseClassification`, `allowedCategories`, `allowedE3`, `expenseTypeSupport`,
`combinationIssue`, `vatClassification`, `expenseAmount`, `validateSums`, `EXPENSE_TABLE_VERSION`, `E3_NAMES` (Greek
names of the E3 codes).

**XML** — `buildExpensesClassificationsXml`, `parseClassificationResponse`, `parseExpensesClassifications`,
`describeErrors`.

## Tests

```bash
npm test
```

No test calls AADE: `fetch` is mocked. To try it for real, ask AADE for test-environment credentials and use
`environment: 'development'`.

## Need the classification itself?

This library sends and checks classifications; it does not decide them. The engine that **proposes** the category and
E3 code for each line (human-learned rules first, then AI limited to the combinations AADE accepts, with an evaluation
harness) is available to license or to acquire: [taktiko.gr/en/for-software-companies](https://www.taktiko.gr/en/for-software-companies).

## Notes

Not affiliated with AADE. The official table bundled here is version 2.0.2 (myDATA API v2.0.2); check it again when AADE
publishes a new one. Use it at your own risk and test against the AADE test environment first.

MIT licence.
