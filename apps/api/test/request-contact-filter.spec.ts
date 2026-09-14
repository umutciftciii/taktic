import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCategory, createTestApp, resetDatabase, serviceRequestPayload, type TestContext } from './harness';

/**
 * Requests now publish to providers without an operator reading them first
 * (see `request-auto-publish.spec.ts`), which removes the one human who used
 * to catch a customer trying to route a provider off-platform before an
 * offer is even made. This is the gate that replaces that read: the two
 * free-text request fields, and every TEXT/TEXTAREA answer, are refused if
 * they carry a phone number, e-mail address, or link.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe('service request contact-detail filter', () => {
  it('refuses a description carrying a phone number, names the field, stores nothing', async () => {
    const category = await createCategory(ctx.prisma);

    const res = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: 'Acil, 0532 123 45 67 arayın' }))
      .expect(400);

    expect(res.body).toMatchObject({
      code: 'CONTACT_DETAILS_IN_TEXT',
      field: 'description',
      kind: 'phone',
    });
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses an address note carrying an e-mail address', async () => {
    const category = await createCategory(ctx.prisma);

    const res = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { addressNote: 'Kapıcıya sorun, mail: ali@example.com' }))
      .expect(400);

    expect(res.body).toMatchObject({
      code: 'CONTACT_DETAILS_IN_TEXT',
      field: 'addressNote',
      kind: 'email',
    });
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses a TEXT answer carrying a link', async () => {
    const category = await createCategory(ctx.prisma);
    const question = await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: category.id,
        key: 'ek-not',
        label: 'Ek not',
        type: 'TEXT',
        isRequired: false,
        isActive: true,
        sortOrder: 0,
      },
    });

    const res = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: question.key, value: 'Detaylar için www.example.com' }],
        }),
      )
      .expect(400);

    expect(res.body).toMatchObject({
      code: 'CONTACT_DETAILS_IN_TEXT',
      field: `answers.${question.key}`,
      kind: 'url',
    });
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses a TEXTAREA answer carrying a phone number', async () => {
    const category = await createCategory(ctx.prisma);
    const question = await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: category.id,
        key: 'detay',
        label: 'Detay',
        type: 'TEXTAREA',
        isRequired: false,
        isActive: true,
        sortOrder: 0,
      },
    });

    const res = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: question.key, value: 'Beni 0532 123 45 67 arayın' }],
        }),
      )
      .expect(400);

    expect(res.body).toMatchObject({
      code: 'CONTACT_DETAILS_IN_TEXT',
      field: `answers.${question.key}`,
      kind: 'phone',
    });
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('accepts a clean description, address note, and TEXT answer', async () => {
    const category = await createCategory(ctx.prisma);
    const question = await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: category.id,
        key: 'ek-not-temiz',
        label: 'Ek not',
        type: 'TEXT',
        isRequired: false,
        isActive: true,
        sortOrder: 0,
      },
    });

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          description: 'Klima montajı gerekiyor, hafta sonu uygun.',
          addressNote: 'Kapıcıdan anahtar alınabilir, 3. kat.',
          answers: [{ questionKey: question.key, value: 'Balkon tarafı olsun.' }],
        }),
      )
      .expect(201);
  });
});
