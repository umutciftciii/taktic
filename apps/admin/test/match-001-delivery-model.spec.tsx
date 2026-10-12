import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CategoryInfoSection } from '../app/categories/[slug]/category-sections';
import {
  categoryChanges,
  categoryPayload,
  categoryProofKeys,
  type CategoryStored,
} from '../app/categories/category-changes';
import { CategoryChangeConsequence } from '../app/categories/category-gates';
import { DeliveryModelField } from '../app/categories/delivery-model-field';
import { requestDeliveryItems } from '../app/requests/[id]/request-delivery';
import { KeyValueList } from '../components/key-value-list';
import { auditFieldLabel, formatAuditValue } from '../components/audit-timeline';
import type { Category, ServiceRequest } from '../lib/api';

/**
 * MATCH-001 — the admin half of the delivery model: the category forms carry
 * it, a change on a service asks first, the history names it, and a request
 * shows its own snapshot beside the category's model today without treating
 * a difference as an error.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const noop = () => undefined;

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

const STORED: CategoryStored = {
  id: 'cat-1',
  name: 'Klima',
  slug: 'klima',
  kind: 'LEAF',
  status: 'ACTIVE',
  parentId: null,
  offerCreditCost: 3,
  unlimitedPackageEligible: false,
  deliveryModel: 'ON_SITE',
};

const FIELDS = {
  id: 'cat-1',
  name: 'Klima',
  kind: 'LEAF',
  status: 'ACTIVE',
  parentId: '',
  sortOrder: '0',
  offerCreditCost: '3',
};

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    parentId: null,
    kind: 'LEAF',
    status: 'ACTIVE',
    name: 'Klima',
    slug: 'klima',
    description: null,
    imageUrl: null,
    coverImageUrl: null,
    iconKey: null,
    isActive: true,
    sortOrder: 0,
    offerCreditCost: 3,
    providerEnrollmentOpen: true,
    unlimitedPackageEligible: false,
    deliveryModel: 'ON_SITE',
    ...overrides,
  } as Category;
}

describe('category payload and changes', () => {
  it('reads a known model only when the form carried one', () => {
    expect(categoryPayload(formData({ ...FIELDS, deliveryModel: 'REMOTE' })).deliveryModel).toBe('REMOTE');
    expect(categoryPayload(formData({ ...FIELDS, deliveryModel: 'HYBRID' })).deliveryModel).toBe('HYBRID');
    // Absent or unknown: not sent, so the stored model is left alone.
    expect(categoryPayload(formData(FIELDS))).not.toHaveProperty('deliveryModel');
    expect(categoryPayload(formData({ ...FIELDS, deliveryModel: 'ONLINE' }))).not.toHaveProperty('deliveryModel');
    expect(categoryPayload(formData({ ...FIELDS, deliveryModel: '' }))).not.toHaveProperty('deliveryModel');
  });

  it('a new model on a service is a change with its own proof; the same model is none', () => {
    const changes = categoryChanges(STORED, categoryPayload(formData({ ...FIELDS, deliveryModel: 'REMOTE' })));
    expect(changes.deliveryModel).toEqual({ from: 'ON_SITE', to: 'REMOTE' });
    expect(categoryProofKeys(changes)).toEqual(['category.delivery-model-update']);

    const same = categoryChanges(STORED, categoryPayload(formData({ ...FIELDS, deliveryModel: 'ON_SITE' })));
    expect(same.deliveryModel).toBeNull();
    expect(categoryProofKeys(same)).toEqual([]);
  });

  it('a stored row without the field reads as ON_SITE', () => {
    const legacy = { ...STORED, deliveryModel: undefined } as unknown as CategoryStored;
    expect(categoryChanges(legacy, categoryPayload(formData({ ...FIELDS, deliveryModel: 'ON_SITE' }))).deliveryModel).toBeNull();
    expect(categoryChanges(legacy, categoryPayload(formData({ ...FIELDS, deliveryModel: 'HYBRID' }))).deliveryModel).toEqual({
      from: 'ON_SITE',
      to: 'HYBRID',
    });
  });

  it('on a group or router the model reaches no request, so it asks nothing', () => {
    const group = { ...STORED, kind: 'GROUP' as const };
    const changes = categoryChanges(group, categoryPayload(formData({ ...FIELDS, kind: 'GROUP', deliveryModel: 'REMOTE' })));
    expect(changes.deliveryModel).toBeNull();
    expect(categoryProofKeys(changes)).toEqual([]);
  });

  it('the dialog names old → new and that open requests keep their mode', () => {
    const said = html(
      <CategoryChangeConsequence
        changes={categoryChanges(STORED, categoryPayload(formData({ ...FIELDS, deliveryModel: 'HYBRID' })))}
        parentNames={{}}
        impact={null}
      />,
    );
    expect(said).toContain('data-testid="category-delivery-model-change"');
    expect(said).toContain('Yerinde →');
    expect(said).toContain('<strong>Hibrit</strong>');
    expect(said).toContain('Mevcut talepler oluşturuldukları hizmet şeklini korur.');
  });
});

describe('category forms', () => {
  it('the field is a labelled select with all three models and its help tied by aria-describedby', () => {
    const out = html(<DeliveryModelField id="dm" defaultValue="REMOTE" kind="LEAF" existing />);
    expect(out).toContain('<label for="dm">Hizmet şekli *</label>');
    expect(out).toMatch(/<select id="dm" name="deliveryModel"[^>]*aria-describedby="dm-help"/);
    expect(out).toContain('id="dm-help"');
    for (const label of ['Yerinde', 'Uzaktan', 'Hibrit']) expect(out).toContain(`>${label}</option>`);
    expect(out).toContain('<option value="REMOTE" selected="">');
    expect(out).toContain('Değişiklik yalnız bundan sonra oluşturulan talepleri etkiler');
    expect(out).not.toContain('bu tipte talep açılmadığı');
  });

  it('on a group the help says it is unused; on create it says nothing about existing requests', () => {
    expect(html(<DeliveryModelField id="dm" defaultValue="ON_SITE" kind="GROUP" existing />)).toContain(
      'bu tipte talep açılmadığı için yok sayılır',
    );
    expect(html(<DeliveryModelField id="dm" defaultValue="ON_SITE" kind={null} existing={false} />)).not.toContain(
      'mevcut talepler',
    );
  });

  it('the edit form carries the field and the read-only view names the model', () => {
    const form = html(
      <CategoryInfoSection category={category({ deliveryModel: 'HYBRID' })} groups={[]} updateAction={noop} canWrite canChangeStatus canUpload={false} />,
    );
    expect(form).toContain('name="deliveryModel"');
    expect(form).toContain('<option value="HYBRID" selected="">');
    const readOnly = html(
      <CategoryInfoSection category={category({ deliveryModel: 'REMOTE' })} groups={[]} updateAction={noop} canWrite={false} canChangeStatus={false} canUpload={false} />,
    );
    expect(readOnly).toMatch(/data-testid="category-delivery-model-value">Uzaktan</);
  });

  it('the create form carries the field too', () => {
    expect(read('app/categories/new/page.tsx')).toContain('<DeliveryModelField');
  });
});

describe('category history', () => {
  it('labels the field and its values in words', () => {
    expect(auditFieldLabel('deliveryModel')).toBe('Hizmet şekli');
    expect(formatAuditValue('CATEGORY', 'deliveryModel', 'REMOTE')).toBe('Uzaktan');
    expect(formatAuditValue('CATEGORY', 'deliveryModel', 'HYBRID')).toBe('Hibrit');
  });
});

describe('request detail', () => {
  const request = (over: Partial<ServiceRequest>, categoryModel?: Category['deliveryModel']) =>
    ({
      deliveryMode: 'ON_SITE',
      city: 'İstanbul',
      district: 'Kadıköy',
      category: { id: 'cat-1', name: 'Çeviri', slug: 'ceviri', deliveryModel: categoryModel },
      ...over,
    }) as ServiceRequest;

  it('a remote request whose category is now on site shows both, with a neutral note and no error styling', () => {
    const out = html(<KeyValueList items={requestDeliveryItems(request({ deliveryMode: 'REMOTE' }, 'ON_SITE'))} />);
    expect(out).toContain('Hizmet şekli (talep)');
    expect(out).toMatch(/data-testid="request-delivery-mode">Uzaktan hizmet</);
    expect(out).toContain('Kategori hizmet şekli (bugün)');
    expect(out).toContain('<span>Yerinde</span>');
    expect(out).toContain('Kategori sonradan değişti; bu talep oluşturulduğu hizmet şeklini korur.');
    expect(out).toContain('Uzaktan talep — konum eşleşmede kullanılmaz.');
    expect(out).not.toMatch(/notice-error|notice-warn|badge-bad|badge-warn|role="alert"|is-error/);
  });

  it('agreeing modes (and HYBRID, which allows either) add no note; on site the place is plain', () => {
    const onSite = html(<KeyValueList items={requestDeliveryItems(request({}, 'ON_SITE'))} />);
    expect(onSite).toMatch(/data-testid="request-delivery-mode">Yerinde hizmet</);
    expect(onSite).toMatch(/data-testid="request-place">İstanbul\/Kadıköy</);
    expect(onSite).not.toContain('sonradan değişti');
    const hybrid = html(<KeyValueList items={requestDeliveryItems(request({ deliveryMode: 'REMOTE' }, 'HYBRID'))} />);
    expect(hybrid).toContain('Hibrit');
    expect(hybrid).not.toContain('sonradan değişti');
  });

  it('a payload without the fields reads as on site, and the category row says "—"', () => {
    const out = html(
      <KeyValueList items={requestDeliveryItems({ ...request({}), deliveryMode: undefined } as unknown as ServiceRequest)} />,
    );
    expect(out).toMatch(/data-testid="request-delivery-mode">Yerinde hizmet</);
    expect(out).toMatch(/data-testid="request-delivery-category-model">—</);
  });

  it('the detail page and the list both use it', () => {
    expect(read('app/requests/[id]/page.tsx')).toContain('...requestDeliveryItems(request)');
    expect(read('app/requests/page.tsx')).toContain("requestDeliveryMode(request) === 'REMOTE'");
  });
});
