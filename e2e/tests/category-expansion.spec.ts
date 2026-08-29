import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createQuestionCondition,
  createRouterRule,
  createSelectQuestion,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { fillRequestFormUpToContact } from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * The category expansion, through the browser.
 *
 * The API specs already pin the rules down; what these scenarios answer is
 * whether a person can actually reach them — whether a draft is really absent
 * from the catalogue, whether a routed answer really lands the customer on the
 * right form, whether a conditional question really appears when it should, and
 * whether an admin can wire all of that up from the screens rather than from a
 * database client.
 */

test.describe('draft categories', () => {
  test('a draft is missing from the catalogue and its page 404s', async ({ browser }) => {
    const live = await createCategory(2, { namePrefix: 'E2E Yayında Hizmet' });
    const draft = await createCategory(2, {
      status: 'DRAFT',
      namePrefix: 'E2E Taslak Hizmet',
    });

    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await visitor.gotoWeb('/categories');
      await assertNoErrorScreen(visitor.page);

      await expect(visitor.page.getByRole('link', { name: live.name })).toBeVisible();
      await expect(visitor.page.getByRole('link', { name: draft.name })).toHaveCount(0);

      // Knowing the slug is not access. The page is a 404, not a 403, so it
      // does not confirm that an unreleased service exists.
      const response = await visitor.page.goto(
        `${primaryRuntime.webUrl}/categories/${draft.slug}`,
      );
      expect(response?.status()).toBe(404);
    } finally {
      await visitor.close();
    }
  });

  test('an admin releases a draft and it appears in the catalogue', async ({ browser }) => {
    const draft = await createCategory(2, {
      status: 'DRAFT',
      namePrefix: 'E2E Yayına Alınacak',
    });
    const adminAccount = await createAdmin();

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/categories/${draft.slug}`);

      // The panel that explains why customers cannot see it yet.
      await expect(admin.page.getByTestId('draft-explainer')).toBeVisible();

      const statusForm = admin.page
        .locator('form')
        .filter({ has: admin.page.getByRole('button', { name: 'Durumu güncelle' }) });
      await statusForm.locator('select[name="status"]').selectOption('ACTIVE');
      await statusForm.getByRole('button', { name: 'Durumu güncelle' }).click();

      await expect(admin.page.getByTestId('draft-explainer')).toHaveCount(0);
      await assertNoErrorScreen(admin.page);

      await visitor.gotoWeb('/categories');
      await expect(visitor.page.getByRole('link', { name: draft.name })).toBeVisible();
    } finally {
      await admin.close();
      await visitor.close();
    }
  });
});

test.describe('conditional questions', () => {
  test('a dependent question appears only on the answer it belongs to', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Banyo' });
    const source = await createSelectQuestion({
      categoryId: category.id,
      key: 'tadilat_tipi',
      label: 'Hangi tip banyo işine ihtiyacınız var?',
      sortOrder: 10,
      isRequired: true,
      options: [
        { key: 'komple', label: 'Komple banyo yenileme' },
        { key: 'fayans', label: 'Fayans döşeme' },
      ],
    });
    const dependent = await createSelectQuestion({
      categoryId: category.id,
      key: 'yapilacak_isler',
      label: 'Komple yenilemede hangi işler yapılacak?',
      sortOrder: 20,
      isRequired: true,
      multi: true,
      options: [
        { key: 'tesisat', label: 'Tesisat' },
        { key: 'dolap', label: 'Dolap' },
      ],
    });
    await createQuestionCondition({
      questionId: dependent.id,
      sourceQuestionId: source.id,
      expectedValues: ['komple'],
    });

    const location = uniqueLocation();
    const values = requestFormValues(location, 'E2E Koşullu Müşteri');
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await visitor.gotoWeb(`/categories/${category.slug}`);
      const form = visitor.page.locator('form.form-card');
      const dependentField = form.locator('select[name="answer_yapilacak_isler"]');

      // Nothing has been answered yet, so the dependent question is not there.
      await expect(dependentField).toHaveCount(0);

      await form.locator('select[name="answer_tadilat_tipi"]').selectOption('fayans');
      await expect(dependentField).toHaveCount(0);

      await form.locator('select[name="answer_tadilat_tipi"]').selectOption('komple');
      await expect(dependentField).toBeVisible();

      // Choosing the other branch again takes it away, rather than leaving a
      // stale answer behind on a question nobody can see.
      await form.locator('select[name="answer_tadilat_tipi"]').selectOption('fayans');
      await expect(dependentField).toHaveCount(0);

      // And the form still submits without it, because it does not apply.
      await fillRequestFormUpToContact(visitor, values);
      const disclosure = visitor.page.getByTestId('contact-disclosure-accept');
      if ((await disclosure.count()) > 0) {
        await disclosure.check();
      }
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(visitor.page).toHaveURL(/\/requests\/success\?id=/);
      await assertNoErrorScreen(visitor.page);

      const requestId = new URL(visitor.page.url()).searchParams.get('id');
      const answers = await prisma().serviceRequestAnswer.findMany({
        where: { requestId: requestId as string },
        select: { questionKey: true },
      });
      expect(answers.map((answer) => answer.questionKey)).toEqual(['tadilat_tipi']);
    } finally {
      await visitor.close();
    }
  });

  test('an ALL rule waits for every expected answer, and the API agrees', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Tam Eslesme' });
    const source = await createSelectQuestion({
      categoryId: category.id,
      key: 'yapilacak_isler',
      label: 'Hangi işler yapılacak?',
      sortOrder: 10,
      isRequired: true,
      multi: true,
      options: [
        { key: 'tesisat', label: 'Tesisat' },
        { key: 'dolap', label: 'Dolap' },
        { key: 'kapi', label: 'Kapı' },
      ],
    });
    const dependent = await createSelectQuestion({
      categoryId: category.id,
      key: 'proje_detayi',
      label: 'Proje çizimi var mı?',
      sortOrder: 20,
      isRequired: true,
      options: [{ key: 'var', label: 'Var' }],
    });
    await createQuestionCondition({
      questionId: dependent.id,
      sourceQuestionId: source.id,
      expectedValues: ['tesisat', 'dolap'],
      matchMode: 'ALL',
    });

    const location = uniqueLocation();
    const values = requestFormValues(location, 'E2E Tam Eşleşme Müşterisi');
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await visitor.gotoWeb(`/categories/${category.slug}`);
      const form = visitor.page.locator('form.form-card');
      const sourceField = form.locator('select[name="answer_yapilacak_isler"]');
      const dependentField = form.locator('select[name="answer_proje_detayi"]');

      // One of the two expected answers is not both of them.
      await sourceField.selectOption(['tesisat']);
      await expect(dependentField).toHaveCount(0);

      // A different answer entirely is no closer.
      await sourceField.selectOption(['kapi']);
      await expect(dependentField).toHaveCount(0);

      // Both, and it appears.
      await sourceField.selectOption(['tesisat', 'dolap']);
      await expect(dependentField).toBeVisible();

      // Extra choices do not take it away again.
      await sourceField.selectOption(['tesisat', 'dolap', 'kapi']);
      await expect(dependentField).toBeVisible();

      await dependentField.selectOption('var');
      await fillRequestFormUpToContact(visitor, values);
      const disclosure = visitor.page.getByTestId('contact-disclosure-accept');
      if ((await disclosure.count()) > 0) {
        await disclosure.check();
      }
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();

      // The API re-derives the same visibility from the stored rule, so the
      // answer to a question the browser showed is the answer it accepts.
      await expect(visitor.page).toHaveURL(/\/requests\/success\?id=/);
      await assertNoErrorScreen(visitor.page);

      const requestId = new URL(visitor.page.url()).searchParams.get('id');
      const answers = await prisma().serviceRequestAnswer.findMany({
        where: { requestId: requestId as string },
        select: { questionKey: true },
        orderBy: { questionKey: 'asc' },
      });
      expect(answers.map((answer) => answer.questionKey)).toEqual([
        'proje_detayi',
        'yapilacak_isler',
      ]);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('routed categories', () => {
  test('a router takes the customer to the leaf their answer names, and the request lands there', async ({
    browser,
  }) => {
    const washer = await createCategory(2, { namePrefix: 'E2E Çamaşır Makinesi Onarımı' });
    const dishwasher = await createCategory(2, { namePrefix: 'E2E Bulaşık Makinesi Onarımı' });
    const router = await createCategory(1, {
      kind: 'ROUTER',
      namePrefix: 'E2E Beyaz Eşya Servisi',
    });

    const routerQuestion = await createSelectQuestion({
      categoryId: router.id,
      key: 'cihaz',
      label: 'Hangi cihaz için servis istiyorsunuz?',
      sortOrder: 10,
      isRequired: true,
      isRouter: true,
      options: [
        { key: 'camasir', label: 'Çamaşır makinesi' },
        { key: 'bulasik', label: 'Bulaşık makinesi' },
      ],
    });
    await createRouterRule({
      questionId: routerQuestion.id,
      optionKey: 'camasir',
      targetCategoryId: washer.id,
    });
    await createRouterRule({
      questionId: routerQuestion.id,
      optionKey: 'bulasik',
      targetCategoryId: dishwasher.id,
    });

    const location = uniqueLocation();
    const values = requestFormValues(location, 'E2E Yönlendirme Müşterisi');
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await visitor.gotoWeb(`/categories/${router.slug}`);
      await assertNoErrorScreen(visitor.page);

      // A router shows its question, not a request form.
      await expect(visitor.page.getByTestId('router-step')).toBeVisible();
      await expect(visitor.page.locator('textarea[name="description"]')).toHaveCount(0);

      await visitor.page.getByTestId('router-option').selectOption('bulasik');
      await visitor.page.getByRole('button', { name: 'Devam et' }).click();

      // The server decided where to go; the browser only said which option was
      // clicked.
      await expect(visitor.page).toHaveURL(new RegExp(`/categories/${dishwasher.slug}\\?`));
      await expect(visitor.page.getByRole('heading', { name: dishwasher.name })).toBeVisible();

      await fillRequestFormUpToContact(visitor, values);
      const disclosure = visitor.page.getByTestId('contact-disclosure-accept');
      if ((await disclosure.count()) > 0) {
        await disclosure.check();
      }
      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      await expect(visitor.page).toHaveURL(/\/requests\/success\?id=/);

      const requestId = new URL(visitor.page.url()).searchParams.get('id');
      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId as string },
        select: { categoryId: true, entryCategoryId: true },
      });

      // The request belongs to the appliance, not to the router that asked
      // which appliance it was — that split is what keeps matching, pricing and
      // work scope on a real service.
      expect(stored.categoryId).toBe(dishwasher.id);
      expect(stored.entryCategoryId).toBe(router.id);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('admin category management', () => {
  test('an admin builds a router, its question and its destination from the screens', async ({
    browser,
  }) => {
    const target = await createCategory(2, { namePrefix: 'E2E Hedef Hizmet' });
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const suffix = Math.random().toString(36).slice(2, 8);
    const routerSlug = `e2e-yonlendirici-${suffix}`;

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // 1. The category itself, as a router, as a draft.
      await admin.gotoAdmin('/categories/new');
      // Scoped to the form that owns the submit button: the admin shell renders
      // its own forms (sign-out, the toolbar), so "the first form on the page"
      // is not this one.
      const createForm = admin.page
        .locator('form')
        .filter({ has: admin.page.getByRole('button', { name: 'Kategoriyi oluştur' }) });
      await createForm.locator('input[name="name"]').fill(`E2E Yönlendirici ${suffix}`);
      await createForm.locator('input[name="slug"]').fill(routerSlug);
      await createForm.locator('select[name="kind"]').selectOption('ROUTER');
      await createForm.locator('select[name="status"]').selectOption('DRAFT');
      await createForm.getByRole('button', { name: 'Kategoriyi oluştur' }).click();

      await expect(admin.page).toHaveURL(new RegExp(`/categories/${routerSlug}$`));
      await assertNoErrorScreen(admin.page);

      // The screen says out loud what a router may not be used for.
      await expect(admin.page.getByTestId('router-explainer')).toBeVisible();
      await expect(admin.page.getByTestId('router-explainer')).toContainText(
        'hizmet verene doğrudan atanamaz',
      );

      // 2. The routing question.
      await admin.page.locator('details.question-create-panel > summary').click();
      const questionForm = admin.page.locator('.question-create-panel form');
      await questionForm.locator('input[name="key"]').fill('cihaz');
      await questionForm.locator('input[name="label"]').fill('Hangi cihaz?');
      await questionForm.locator('select[name="type"]').selectOption('SELECT');
      await questionForm.locator('select[name="isRequired"]').selectOption('true');
      await questionForm.locator('select[name="isRouter"]').selectOption('true');
      await questionForm
        .locator('textarea[name="options"]')
        .fill(JSON.stringify([{ key: 'hedef', label: 'Hedef hizmet' }]));
      await questionForm.getByRole('button', { name: 'Soruyu oluştur' }).click();

      await expect(admin.page.getByText('cihaz', { exact: false }).first()).toBeVisible();
      await assertNoErrorScreen(admin.page);

      // 3. Its destination.
      const routingForm = admin.page
        .locator('form')
        .filter({ has: admin.page.getByRole('button', { name: 'Yönlendirmeyi kaydet' }) });
      await routingForm.locator('select[name="routerTargetSlug"]').selectOption(target.slug);
      await routingForm.getByRole('button', { name: 'Yönlendirmeyi kaydet' }).click();
      await assertNoErrorScreen(admin.page);

      /*
       * 4. What the database now holds — the same wiring the customer flow
       * reads.
       *
       * Polled rather than read once: a server action is an in-flight POST, and
       * a straight read races the round trip it started. `assertNoErrorScreen`
       * above is what turns a genuinely failed save into a reported failure
       * rather than a timeout here.
       */
      await expect
        .poll(async () =>
          prisma().serviceCategoryRouterRule.count({
            where: { question: { category: { slug: routerSlug } } },
          }),
        )
        .toBe(1);

      const rule = await prisma().serviceCategoryRouterRule.findFirstOrThrow({
        where: { question: { category: { slug: routerSlug } } },
        include: { question: true, targetCategory: true },
      });

      expect(rule.optionKey).toBe('hedef');
      expect(rule.targetCategory.slug).toBe(target.slug);
      expect(rule.question.isRouter).toBe(true);
    } finally {
      await admin.close();
    }
  });

  test('an admin adds a conditional question and the rule is stored', async ({ browser }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Koşul Yönetimi' });
    const source = await createSelectQuestion({
      categoryId: category.id,
      key: 'kaynak',
      label: 'Kaynak soru',
      sortOrder: 10,
      isRequired: true,
      options: [
        { key: 'evet', label: 'Evet' },
        { key: 'hayir', label: 'Hayır' },
      ],
    });

    await createSelectQuestion({
      categoryId: category.id,
      key: 'hedef',
      label: 'Hedef soru',
      sortOrder: 20,
      options: [{ key: 'a', label: 'A' }],
    });

    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/categories/${category.slug}`);

      // Open the target question's editor. Every question row carries a
      // condition form of its own, so the locator has to be scoped to this
      // question rather than to the page.
      const targetRow = admin.page
        .locator('details.question-row')
        .filter({ hasText: 'Hedef soru' });
      await targetRow.locator('summary').click();

      // Source and expected answers in one submission: the options are offered
      // qualified by their question, so the rule never needs a first save that
      // stores nothing.
      const conditionForm = targetRow
        .locator('form')
        .filter({ has: admin.page.getByRole('button', { name: 'Koşulu kaydet' }) });
      await conditionForm.locator('select[name="sourceQuestionKey"]').selectOption('kaynak');
      await conditionForm.locator('select[name="expectedValues"]').selectOption(['kaynak::evet']);
      await conditionForm.getByRole('button', { name: 'Koşulu kaydet' }).click();
      await assertNoErrorScreen(admin.page);

      // Polled for the same reason the router case is: the save is a POST the
      // click only started.
      await expect
        .poll(async () =>
          prisma().serviceRequestQuestionCondition.count({
            where: { question: { key: 'hedef', categoryId: category.id } },
          }),
        )
        .toBe(1);

      const condition = await prisma().serviceRequestQuestionCondition.findFirstOrThrow({
        where: { question: { key: 'hedef', categoryId: category.id } },
        include: { sourceQuestion: true },
      });

      expect(condition.sourceQuestion.id).toBe(source.id);
      expect(condition.expectedValues).toEqual(['evet']);
      // No mode chosen means ANY, on the screen as in the database.
      expect(condition.matchMode).toBe('ANY');

      // The source is single-choice, so "tamamı" would be the same test under a
      // second name — the screen says so by refusing to offer it.
      //
      // The DOM property rather than `toBeDisabled`: that matcher reports an
      // <option> as enabled whatever its attribute says, so it would pass here
      // for the wrong reason and keep passing if the option were ever offered.
      await expect(
        conditionForm.locator('select[name="matchMode"] option[value="ALL"]'),
      ).toHaveJSProperty('disabled', true);
    } finally {
      await admin.close();
    }
  });

  test('an admin sets a multi-select rule to “tamamı” and the customer form obeys it', async ({
    browser,
  }) => {
    const category = await createCategory(2, { namePrefix: 'E2E Tamami Yonetimi' });
    await createSelectQuestion({
      categoryId: category.id,
      key: 'isler',
      label: 'Yapılacak işler',
      sortOrder: 10,
      isRequired: true,
      multi: true,
      options: [
        { key: 'tesisat', label: 'Tesisat' },
        { key: 'dolap', label: 'Dolap' },
      ],
    });
    await createSelectQuestion({
      categoryId: category.id,
      key: 'detay',
      label: 'Detay sorusu',
      sortOrder: 20,
      options: [{ key: 'var', label: 'Var' }],
    });

    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/categories/${category.slug}`);

      const targetRow = admin.page
        .locator('details.question-row')
        .filter({ hasText: 'Detay sorusu' });
      await targetRow.locator('summary').click();

      const conditionForm = targetRow
        .locator('form')
        .filter({ has: admin.page.getByRole('button', { name: 'Koşulu kaydet' }) });
      await conditionForm.locator('select[name="sourceQuestionKey"]').selectOption('isler');
      await conditionForm
        .locator('select[name="expectedValues"]')
        .selectOption(['isler::tesisat', 'isler::dolap']);
      await conditionForm.locator('select[name="matchMode"]').selectOption('ALL');
      await conditionForm.getByRole('button', { name: 'Koşulu kaydet' }).click();
      await assertNoErrorScreen(admin.page);

      await expect
        .poll(async () =>
          prisma().serviceRequestQuestionCondition.count({
            where: { question: { key: 'detay', categoryId: category.id }, matchMode: 'ALL' },
          }),
        )
        .toBe(1);

      // What the admin wired up is what the customer meets: one of the two
      // answers is not enough, both are.
      await visitor.gotoWeb(`/categories/${category.slug}`);
      const form = visitor.page.locator('form.form-card');
      const dependentField = form.locator('select[name="answer_detay"]');

      await form.locator('select[name="answer_isler"]').selectOption(['tesisat']);
      await expect(dependentField).toHaveCount(0);

      await form.locator('select[name="answer_isler"]').selectOption(['tesisat', 'dolap']);
      await expect(dependentField).toBeVisible();
    } finally {
      await admin.close();
      await visitor.close();
    }
  });
});
