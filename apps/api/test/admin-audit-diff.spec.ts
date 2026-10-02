import { describe, expect, it } from 'vitest';
import { diffAuditFields, readAuditChanges } from '../src/common/admin-audit';

/** ADMIN-ACTION-AUDIT-001: the one diff primitive every catalogue and settings write uses. */
describe('diffAuditFields', () => {
  const fields = ['name', 'price', 'scope', 'codes', 'note'] as const;

  it('lists only changed fields, in field order', () => {
    expect(
      diffAuditFields(
        { name: 'A', price: 100, scope: [], codes: ['X'], note: null },
        { name: 'A', price: 120, scope: [], codes: ['X'], note: 'yeni' },
        fields,
      ),
    ).toEqual([
      { field: 'price', from: 100, to: 120 },
      { field: 'note', from: null, to: 'yeni' },
    ]);
  });

  it('is empty for a no-op, whatever the set order', () => {
    expect(
      diffAuditFields(
        { scope: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }], codes: ['Y', 'X'] },
        { scope: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], codes: ['X', 'Y'] },
        fields,
      ),
    ).toEqual([]);
  });

  it('a create lists every field that has a value, from null', () => {
    expect(diffAuditFields(null, { name: 'A', price: 0, note: null }, fields)).toEqual([
      { field: 'name', from: null, to: 'A' },
      { field: 'price', from: null, to: 0 },
    ]);
  });

  it('a reference set is stored sorted by id', () => {
    expect(
      diffAuditFields({ scope: [] }, { scope: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }] }, fields),
    ).toEqual([{ field: 'scope', from: [], to: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }]);
  });
});

describe('readAuditChanges', () => {
  it('drops anything malformed instead of guessing', () => {
    expect(readAuditChanges([{ field: 'name', from: 'a', to: 'b' }, { nope: true }, 'x'] as never)).toEqual([
      { field: 'name', from: 'a', to: 'b' },
    ]);
    expect(readAuditChanges({} as never)).toEqual([]);
  });
});
