import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, badgeClass } from '../components/badge';
import { ConfirmDialog } from '../components/confirm-dialog';
import { DataTable } from '../components/data-table';
import { DetailHeader } from '../components/detail-header';
import { EmptyState } from '../components/empty-state';
import { FilterBar, FilterField } from '../components/filter-bar';
import { InfoPopover } from '../components/info-popover';
import { KeyValueList } from '../components/key-value-list';
import { PageHeader } from '../components/page-header';
import { CursorPagination, Pagination } from '../components/pagination';
import { StickyActionBar } from '../components/sticky-action-bar';
import { SummaryStrip } from '../components/summary-strip';
import { SavedViewTabs, Tabs } from '../components/tabs';
import { Timeline } from '../components/timeline';
import { Toggle } from '../components/toggle';

/**
 * ADMIN-DESIGN-001 Faz 2 — the shared components, as the markup the server
 * sends.
 *
 * What a screen reader and a no-JavaScript browser get is decided here, before
 * any script runs: names, roles, `aria-current`, `aria-expanded`, which links
 * are links. The behaviour that needs a browser (Esc, a click outside, the
 * modal dialog) is covered by e2e/tests/admin-notifications-list.spec.ts on
 * the reference screen.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('PageHeader', () => {
  it('renders exactly as before when no ⓘ is given', () => {
    const markup = html(<PageHeader title="Başlık" subtitle="Özet" />);
    expect(markup).toBe(
      '<header class="page-header"><div class="page-header-row"><div class="page-header-text"><h1 class="page-title">Başlık</h1><p class="page-subtitle">Özet</p></div></div></header>',
    );
  });

  it('puts a named, collapsed ⓘ beside the title', () => {
    const markup = html(<PageHeader title="Başlık" info="Bu ekran silinemez." />);
    expect(markup).toContain('<div class="page-title-row"><h1 class="page-title">Başlık</h1>');
    expect(markup).toContain('aria-label="Bu ekran ne işe yarar?"');
    expect(markup).toContain('aria-expanded="false"');
  });
});

describe('InfoPopover', () => {
  it('is a button that controls a panel already in the DOM, hidden until opened', () => {
    const markup = html(<InfoPopover label="Talep kalitesi nedir?">Açıklama</InfoPopover>);
    expect(markup).toMatch(/<button type="button" class="info-popover-trigger" aria-label="Talep kalitesi nedir\?" aria-expanded="false" aria-controls="([^"]+)"/);
    const controls = markup.match(/aria-controls="([^"]+)"/)?.[1];
    expect(markup).toContain(`id="${controls}" class="info-popover-panel" hidden=""`);
    expect(markup).toContain('Açıklama');
  });
});

describe('Tabs and SavedViewTabs', () => {
  const items = [
    { key: '', label: 'Tümü', count: 12 },
    { key: 'FAILED', label: 'Başarısız' },
  ];

  it('are links in a named navigation, the open one marked aria-current="page"', () => {
    const markup = html(
      <SavedViewTabs label="Görünümler" items={items} active="" path="/n" params={{ channel: 'SMS', page: 3 }} param="status" />,
    );
    expect(markup).toContain('<nav class="tabs tabs-views" aria-label="Görünümler">');
    expect(markup).toContain('<a class="tabs-link" aria-current="page" href="/n?channel=SMS">');
    expect(markup).toContain('href="/n?channel=SMS&amp;status=FAILED"');
    expect(markup).not.toContain('role="tab"');
    // Only the tab that has its number draws a counter.
    expect(markup.match(/tabs-count/g)).toHaveLength(1);
    expect(markup).toContain('12<span class="sr-only"> kayıt</span>');
  });

  it('write ?tab= and leave the default tab as the plain URL', () => {
    const markup = html(
      <Tabs
        label="Talep sekmeleri"
        items={[
          { key: 'bilgi', label: 'Talep bilgileri' },
          { key: 'teklifler', label: 'Teklifler' },
        ]}
        active="teklifler"
        defaultKey="bilgi"
        path="/requests/1"
      />,
    );
    expect(markup).toContain('href="/requests/1"');
    expect(markup).toContain('<a class="tabs-link" aria-current="page" href="/requests/1?tab=teklifler">');
    expect(markup.match(/aria-current/g)).toHaveLength(1);
  });
});

describe('FilterBar', () => {
  it('is a GET search form with labelled fields, and "Temizle" only when there is something to clear', () => {
    const field = (
      <FilterField label="Durum" htmlFor="f-status">
        <select id="f-status" name="status" />
      </FilterField>
    );
    const idle = html(<FilterBar action="/n">{field}</FilterBar>);
    expect(idle).toContain('<form class="filter-bar" role="search" aria-label="Filtreler" action="/n" method="get">');
    expect(idle).toContain('<label for="f-status">Durum</label>');
    expect(idle).toContain('>Filtrele</button>');
    expect(idle).not.toContain('Temizle');

    const filtered = html(
      <FilterBar action="/n" clearHref="/n" preserve={{ tab: 'x', page: 4, empty: '' }}>
        {field}
      </FilterBar>,
    );
    expect(filtered).toContain('href="/n">Temizle</a>');
    expect(filtered).toContain('<input type="hidden" name="tab" value="x"/>');
    expect(filtered).not.toContain('name="empty"');
  });
});

describe('DataTable', () => {
  it('is a named, focusable scroll region around a captioned table with column headers', () => {
    const markup = html(
      <DataTable
        caption="Kayıtlar"
        columns={[
          { key: 'a', label: 'Ad' },
          { key: 'n', label: 'Deneme', align: 'end' },
          { key: 'x', label: 'İşlemler', srOnly: true },
        ]}
        testId="t"
      >
        <tr>
          <td>1</td>
        </tr>
      </DataTable>,
    );
    expect(markup).toContain('class="table-scroll data-list-scroll" role="region" aria-label="Kayıtlar" tabindex="0"');
    expect(markup).toContain('<caption class="sr-only">Kayıtlar</caption>');
    expect(markup).toContain('<th scope="col" class="is-num">Deneme</th>');
    expect(markup).toContain('<th scope="col"><span class="sr-only">İşlemler</span></th>');
  });
});

describe('Pagination', () => {
  it('links both ways with the filters kept, and says where the operator is', () => {
    const markup = html(
      <Pagination path="/n" params={{ status: 'FAILED' }} page={2} pageSize={50} total={148} />,
    );
    expect(markup).toContain('<nav class="pagination" aria-label="Sayfalama">');
    expect(markup).toContain('148 kaydın 51–100 arası gösteriliyor');
    expect(markup).toContain('rel="prev" data-testid="pagination-previous" href="/n?status=FAILED"');
    expect(markup).toContain('rel="next" data-testid="pagination-next" href="/n?status=FAILED&amp;page=3"');
  });

  it('keeps a closed direction in place as aria-disabled text, not a link', () => {
    const markup = html(<Pagination path="/n" params={{}} page={1} pageSize={50} total={10} />);
    expect(markup).toMatch(/<span class="btn btn-secondary btn-sm is-disabled" aria-disabled="true"[^>]*>Önceki<\/span>/);
    expect(markup).toMatch(/<span class="btn btn-secondary btn-sm is-next is-disabled" aria-disabled="true"[^>]*>Sonraki<\/span>/);
    expect(markup).not.toContain('<a');
  });

  it('has a cursor variant that never claims a total', () => {
    const markup = html(<CursorPagination count={25} previousHref={null} nextHref="/n?cursor=abc" />);
    expect(markup).toContain('Bu sayfada 25 kayıt');
    expect(markup).toContain('rel="next" data-testid="pagination-next" href="/n?cursor=abc"');
    expect(markup).not.toMatch(/kaydın/);
  });
});

describe('Badge', () => {
  it("maps the design's four tones onto the classes the panel already uses", () => {
    expect(badgeClass('neutral')).toBe('badge badge-muted');
    expect(badgeClass('success')).toBe('badge badge-good');
    expect(badgeClass('warning')).toBe('badge badge-warn');
    expect(badgeClass('danger')).toBe('badge badge-bad');
    expect(html(<Badge tone="danger">Başarısız</Badge>)).toBe('<span class="badge badge-bad">Başarısız</span>');
  });
});

describe('SummaryStrip, KeyValueList and Timeline', () => {
  it('read each figure with its label', () => {
    const markup = html(<SummaryStrip label="Özet" items={[{ label: 'Kredi', value: 240, note: 'bugün', tone: 'success' }]} />);
    expect(markup).toBe(
      '<dl class="summary-strip" aria-label="Özet"><div class="summary-strip-item"><dt>Kredi</dt><dd class="summary-strip-value tone-success">240</dd><dd class="summary-strip-note">bugün</dd></div></dl>',
    );
  });

  it('never leave a value cell empty', () => {
    const markup = html(<KeyValueList items={[{ label: 'Telefon', value: null }]} />);
    expect(markup).toContain('<dt>Telefon</dt><dd>—</dd>');
  });

  it('draw what happened as an ordered list of <time>d entries, or the empty state', () => {
    const markup = html(
      <Timeline items={[{ key: '1', when: '19 Eyl 14:32', dateTime: '2026-09-19T11:32:00Z', title: 'Talep geldi', actor: 'Sistem' }]} />,
    );
    expect(markup).toContain('<ol class="timeline"><li class="timeline-item"><time class="timeline-when" dateTime="2026-09-19T11:32:00Z">19 Eyl 14:32</time>');
    expect(html(<Timeline items={[]} empty={<EmptyState title="Henüz olay yok" />} />)).toContain('Henüz olay yok');
  });
});

describe('Toggle', () => {
  it('is a named role="switch" whose state is aria-checked, not part of its name', () => {
    const on = html(<Toggle checked label="Gelen talepler kendiliğinden yayına girsin" type="submit" />);
    expect(on).toContain('type="submit" role="switch" aria-checked="true" aria-label="Gelen talepler kendiliğinden yayına girsin"');
    expect(on).toContain('<span class="toggle-state" aria-hidden="true">Açık</span>');
    const off = html(<Toggle checked={false} label="X" stateText={false} />);
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain('toggle-state');
  });
});

describe('ConfirmDialog', () => {
  it('keeps the form\'s own submit button and a closed, labelled modal next to it', () => {
    const markup = html(
      <form>
        <ConfirmDialog
          triggerLabel="Hesabı pasife al"
          title="Hesap pasife alınsın mı?"
          consequence="Kullanıcı bir daha giriş yapamaz."
          confirmLabel="Pasife al"
          name="intent"
          value="deactivate"
        />
      </form>,
    );
    const trigger = markup.match(/<button type="submit"[^>]*>Hesabı pasife al<\/button>/)?.[0] ?? '';
    expect(trigger).toContain('class="btn btn-destructive"');
    expect(trigger).toContain('name="intent"');
    expect(trigger).toContain('value="deactivate"');
    expect(trigger).toContain('aria-haspopup="dialog"');
    const titleId = markup.match(/<h2 class="confirm-dialog-title" id="([^"]+)"/)?.[1];
    const bodyId = markup.match(/<div class="confirm-dialog-body" id="([^"]+)"/)?.[1];
    expect(markup).toContain(`<dialog class="confirm-dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${bodyId}"`);
    // Closed until the trigger is pressed: no `open` attribute.
    expect(markup).not.toMatch(/<dialog[^>]* open/);
    // Neither dialog button can submit the form on its own.
    expect(markup.match(/type="submit"/g)).toHaveLength(1);
    expect(markup).toContain('Kullanıcı bir daha giriş yapamaz.');
  });

  it('keeps its trigger closed while the screen says so (Faz 3A: a client call in flight)', () => {
    const markup = html(
      <form>
        <ConfirmDialog triggerLabel="İadeyi onayla" title="?" consequence="." confirmLabel="Evet" disabled />
      </form>,
    );
    const trigger = markup.match(/<button type="submit"[^>]*>İadeyi onayla<\/button>/)?.[0] ?? '';
    expect(trigger).toContain('disabled=""');
    expect(trigger).toContain('aria-disabled="true"');
  });
});

describe('DetailHeader (Faz 3A)', () => {
  it('draws the way back, the card and the strip, and nothing it was not given', () => {
    const markup = html(
      <DetailHeader
        back={{ href: '/requests', label: 'Tüm talepler' }}
        badges={<span className="badge">Onaylandı</span>}
        meta="TL-1 · 19 Eyl"
        title="Kombi servisi · Kadıköy, İstanbul"
        facts={[{ label: 'Talep kalitesi', value: '82 / 100' }]}
        factsLabel="Talep özeti"
      />,
    );
    expect(markup).toContain('<a class="detail-back" href="/requests">');
    expect(markup).toContain('<h1 class="detail-card-title">Kombi servisi · Kadıköy, İstanbul</h1>');
    expect(markup).toContain('<dl class="summary-strip" aria-label="Talep özeti">');
    // No actions and no subtitle were given: no empty boxes for them.
    expect(markup).not.toContain('detail-card-actions');
    expect(markup).not.toContain('detail-card-subtitle');

    const bare = html(<DetailHeader back={{ href: '/offers', label: 'Tüm teklifler' }} title="T" facts={[]} />);
    expect(bare).not.toContain('summary-strip');
    expect(bare).not.toContain('detail-card-badges');
  });
});

describe('StickyActionBar', () => {
  it('saves and resets the form it names, and starts clean', () => {
    const markup = html(<StickyActionBar formId="settings" note="Son değişiklik: dün" />);
    expect(markup).toContain('data-dirty="false"');
    expect(markup).toContain('<p class="sticky-action-bar-status" role="status">Değişiklik yok</p>');
    expect(markup).toContain('<button type="reset" form="settings" class="btn btn-secondary" disabled="">Vazgeç</button>');
    expect(markup).toContain('<button type="submit" form="settings" class="btn btn-primary">Değişiklikleri kaydet</button>');
  });
});
