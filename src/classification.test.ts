import table from './data/expense-combinations-v2.0.2.json';
import { allowedCategories, allowedE3, combinationIssue, expenseAmount, expenseTypeSupport, validateExpenseClassification, validateSums, vatClassification, EXPENSE_TABLE_VERSION } from './classification';

describe('official combinations table', () => {
  it('is version 2.0.2 and complete', () => {
    expect(EXPENSE_TABLE_VERSION).toBe('2.0.2');
    expect(Object.keys(table.types)).toHaveLength(53);
  });

  it('every reference to an E3 list exists and every code is well formed', () => {
    for (const [t, entry] of Object.entries(table.types)) {
      if (entry === 'related') continue;
      for (const v of Object.values(entry as Record<string, number | string | null>)) {
        if (typeof v === 'number') expect({ t, ok: v >= 0 && v < table.e3Lists.length }).toEqual({ t, ok: true });
      }
    }
    for (const l of table.e3Lists) for (const c of l.split(' ')) expect(c).toMatch(/^\d{3}(_\d{3})?$/);
  });
});

describe('validateExpenseClassification', () => {
  it('accepts a combination from the table', () => {
    expect(validateExpenseClassification('1.1', 'category2_4', 'E3_585_016')).toEqual({ ok: true });
    expect(validateExpenseClassification('13.1', 'category2_7', 'E3_882_001')).toEqual({ ok: true });
    expect(validateExpenseClassification('17.1', 'category2_6', 'E3_581_001')).toEqual({ ok: true });
  });

  it('accepts common supplier combinations (utilities, fuel, fees)', () => {
    const ok = (t: string, cats: string[], e3: string) => cats.forEach(c => expect([t, c, e3, validateExpenseClassification(t, `category${c}`, e3).ok]).toEqual([t, c, e3, true]));
    for (const t of ['1.1', '2.1', '5.2', '13.1']) {
      for (const e3 of ['E3_585_011', 'E3_585_012', 'E3_585_013']) ok(t, ['2_4'], e3);
      ok(t, ['2_4', '2_5'], 'E3_586');
      ok(t, ['2_3', '2_4', '2_5'], 'E3_585_015');
      ok(t, ['2_3', '2_4', '2_5'], 'E3_585_009');
    }
    for (const t of ['14.3', '14.4']) for (const e3 of ['E3_585_015', 'E3_585_010']) ok(t, ['2_3', '2_4', '2_5'], e3);
    // E3_585_010 on a domestic type only with 2.95
    for (const t of ['1.1', '2.1', '13.1']) {
      expect(validateExpenseClassification(t, 'category2_4', 'E3_585_010').ok).toBe(false);
      expect(validateExpenseClassification(t, 'category2_95', 'E3_585_010').ok).toBe(true);
    }
  });

  it('rejects an E3 code the category does not accept (fixed asset ↔ expense)', () => {
    const r = validateExpenseClassification('1.1', 'category2_7', 'E3_585_016');
    expect(r).toMatchObject({ ok: false, issue: 'e3_not_allowed', allowedE3: ['E3_882_001', 'E3_883_001'] });
    expect(validateExpenseClassification('1.1', 'category2_4', 'E3_882_001').ok).toBe(true);
  });

  it('rejects a category the invoice type does not accept', () => {
    const r = validateExpenseClassification('1.1', 'category2_6', 'E3_581_001');
    expect(r).toMatchObject({ ok: false, issue: 'category_not_allowed' });
    expect(allowedCategories('1.1')).toEqual(expect.arrayContaining(['category2_1', 'category2_7']));
    expect(allowedCategories('1.1')).not.toContain('category2_6');
  });

  it('tells a malformed code apart from one that is not allowed', () => {
    expect(validateExpenseClassification('1.1', 'category2_4', 'E3-585-016')).toMatchObject({ ok: false, issue: 'e3_malformed' });
    expect(validateExpenseClassification('1.1', 'category2_4', 'E3_999_999')).toMatchObject({ ok: false, issue: 'e3_not_allowed' });
  });

  it('a type without expenses, unknown or dependent on other invoices is not accepted', () => {
    expect(validateExpenseClassification('1.2', 'category2_4', 'E3_585_016')).toMatchObject({ ok: false, issue: 'invoice_type_without_expenses' });
    expect(validateExpenseClassification('99.9', 'category2_4', 'E3_585_016')).toMatchObject({ ok: false, issue: 'unknown_invoice_type' });
    expect(validateExpenseClassification('5.1', 'category2_4', 'E3_585_016')).toMatchObject({ ok: false, issue: 'depends_on_related' });
    expect([expenseTypeSupport('1.1'), expenseTypeSupport('1.2'), expenseTypeSupport('5.1'), expenseTypeSupport('99.9')])
      .toEqual(['ok', 'no_expenses', 'related', 'unknown']);
  });

  it('combinationIssue accepts related-invoice types only when a person decided', () => {
    expect(combinationIssue('5.1', 'category2_4', 'E3_585_016', true)).toBeNull();
    expect(combinationIssue('5.1', 'category2_4', 'E3_585_016', false)).toMatch(/related invoices/);
    expect(combinationIssue('1.1', 'category2_4', 'E3_585_016', false)).toBeNull();
  });

  it('allowedE3 returns undefined if the combination does not exist and [] if the category takes no E3', () => {
    expect(allowedE3('1.1', 'category2_6')).toBeUndefined();
    expect(allowedE3('17.6', 'category2_12')).toEqual([]);
    expect(allowedE3('1.1', 'category2_1')).toContain('E3_102_001');
  });
});

describe('vatClassification', () => {
  const line = (over: Partial<{ vatCategory: number | null; vatAmount: number; exemptionCause: number | null }> = {}) =>
    ({ vatCategory: 1, vatAmount: 24, exemptionCause: null, ...over });

  it('domestic purchases and expenses take VAT_361; fixed assets, VAT_362', () => {
    expect(vatClassification('category2_4', line())).toEqual({ type: 'VAT_361' });
    expect(vatClassification('category2_3', line({ vatCategory: 2 }))).toEqual({ type: 'VAT_361' });
    expect(vatClassification('category2_7', line())).toEqual({ type: 'VAT_362' });
  });

  it('a line without VAT, at 0 % or exempt takes no VAT classification', () => {
    expect(vatClassification('category2_4', line({ vatCategory: 8, vatAmount: 0 }))).toBeNull();
    expect(vatClassification('category2_4', line({ vatCategory: 7, vatAmount: 0 }))).toBeNull();
    expect(vatClassification('category2_4', line({ vatCategory: null }))).toBeNull();
    expect(vatClassification('category2_4', line({ vatAmount: 0 }))).toBeNull();
    expect(vatClassification('category2_4', line({ exemptionCause: 3 }))).toBeNull();
  });

  it('expenses without the right to deduct VAT (2.5) take no VAT classification and their amount includes VAT', () => {
    expect(vatClassification('category2_5', line())).toBeNull();
    expect(expenseAmount('category2_5', 50, 12)).toBe(62);
    expect(expenseAmount('category2_5', 0.1, 0.2)).toBe(0.3);
    expect(expenseAmount('category2_4', 50, 12)).toBe(50);
    expect(expenseAmount('category2_7', 50, 12)).toBe(50);
  });

  it('the article 39α exemption is reported as unsupported', () => {
    expect(vatClassification('category2_4', line({ exemptionCause: 16 }))).toMatchObject({ unsupported: expect.stringContaining('39α') });
  });
});

describe('validateSums', () => {
  const lines = [
    { net: 100, vat: 24, classifiedAmount: 100 },
    { net: 50.5, vat: 12.12, classifiedAmount: 50.5 },
  ];

  it('accepts sums that match', () => {
    expect(validateSums(lines, { totalNetValue: 150.5, totalVatAmount: 36.12 })).toEqual({ ok: true, errors: [] });
  });

  it('detects a line whose classified amount is not its net value', () => {
    const r = validateSums([{ ...lines[0], classifiedAmount: 90 }, lines[1]]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/Line 1/);
  });

  it('detects lines that do not add up to the invoice total', () => {
    expect(validateSums(lines, { totalNetValue: 160 }).errors[0]).toMatch(/total net/);
    expect(validateSums(lines, { totalNetValue: 150.5, totalVatAmount: 40 }).errors[0]).toMatch(/total VAT/);
  });

  it('tolerates one-cent rounding differences', () => {
    expect(validateSums([{ net: 33.33, classifiedAmount: 33.33 }, { net: 33.33, classifiedAmount: 33.33 }], { totalNetValue: 66.67 }).ok).toBe(true);
  });
});
