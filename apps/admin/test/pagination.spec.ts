import { describe, expect, it } from 'vitest';
import { cursorSummary, pageSummary, pageWindow } from '../lib/pagination';

/** ADMIN-DESIGN-001 Faz 2 — the list footer's arithmetic and its words. */
describe('pagination', () => {
  it('describes a full first page', () => {
    const window = pageWindow({ page: 1, pageSize: 50, total: 148 });
    expect(window).toMatchObject({ start: 1, end: 50, totalPages: 3, hasPrevious: false, hasNext: true });
    expect(pageSummary(window)).toBe('148 kaydın 1–50 arası gösteriliyor');
  });

  it('stops at the last row on the last page', () => {
    const window = pageWindow({ page: 3, pageSize: 50, total: 148 });
    expect(window).toMatchObject({ start: 101, end: 148, hasPrevious: true, hasNext: false });
    expect(pageSummary(window)).toBe('148 kaydın 101–148 arası gösteriliyor');
  });

  it('names a single row on a page, and a single row in all', () => {
    expect(pageSummary(pageWindow({ page: 2, pageSize: 50, total: 51 }))).toBe('51 kaydın 51. kaydı gösteriliyor');
    expect(pageSummary(pageWindow({ page: 1, pageSize: 50, total: 1 }))).toBe('1 kayıt');
  });

  it('formats large totals the Turkish way', () => {
    expect(pageSummary(pageWindow({ page: 2, pageSize: 50, total: 1284 }))).toBe(
      '1.284 kaydın 51–100 arası gösteriliyor',
    );
  });

  it('has nothing to page through when the list is empty', () => {
    const window = pageWindow({ page: 1, pageSize: 50, total: 0 });
    expect(window).toMatchObject({ start: 0, end: 0, hasPrevious: false, hasNext: false, outOfRange: false });
    expect(pageSummary(window)).toBe('0 kayıt');
  });

  it('says so when a URL asks for a page past the end, and still offers the way back', () => {
    const window = pageWindow({ page: 9, pageSize: 50, total: 60 });
    expect(window).toMatchObject({ outOfRange: true, start: 0, end: 0, hasPrevious: true, hasNext: false });
    expect(pageSummary(window)).toBe('Bu sayfada kayıt yok · toplam 60 kayıt');
  });

  it("takes the API's own hasNextPage over its arithmetic", () => {
    expect(pageWindow({ page: 1, pageSize: 50, total: 40, hasNextPage: true }).hasNext).toBe(true);
    expect(pageWindow({ page: 1, pageSize: 50, total: 148, hasNextPage: false }).hasNext).toBe(false);
  });

  it('clamps nonsense input', () => {
    expect(pageWindow({ page: 0, pageSize: 0, total: -5 })).toMatchObject({ page: 1, pageSize: 1, total: 0 });
  });

  it('never claims a total for a cursor list', () => {
    expect(cursorSummary(0)).toBe('Bu sayfada kayıt yok');
    expect(cursorSummary(25)).toBe('Bu sayfada 25 kayıt');
    expect(cursorSummary(3, 'hareket')).toBe('Bu sayfada 3 hareket');
    // ADMIN-BACKEND-TRUTH-002: a counted cursor list says its real total too.
    expect(cursorSummary(25, 'kampanya', 60)).toBe('Toplam 60 kampanya · bu sayfada 25');
    expect(cursorSummary(0, 'kampanya', 60)).toBe('Bu sayfada kampanya yok · toplam 60 kampanya');
    expect(cursorSummary(0, 'kampanya', 0)).toBe('0 kampanya');
  });
});
