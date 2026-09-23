import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { AdminPermission, UserRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminAccessGuard } from '../src/modules/auth/admin-access.guard';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/admin-permissions';
import { PermissionsGuard } from '../src/modules/auth/permissions.guard';
import { ROLES_KEY } from '../src/modules/auth/auth.decorators';
import {
  REQUIRED_PERMISSIONS_KEY,
  STAFF_PERMISSIONS_KEY,
} from '../src/modules/auth/permissions.decorator';
import { ADMIN_ROUTE_PERMISSIONS, ROOT_ONLY_ROUTES } from '../src/modules/auth/route-permission-map';
import { createTestApp, type TestContext } from './harness';

/**
 * PR-0 — the route/permission map is a contract, not a document.
 *
 * Every assertion here reads the *booted application* and compares it with
 * `route-permission-map.ts`. That is what stops the map from rotting: a
 * guarded admin route nobody classified fails, and a classification that names
 * no route fails too, so neither adding nor deleting a route can quietly leave
 * the two out of step.
 *
 * The routes are read from Nest's own module container rather than from
 * Express's router, because only the container carries the decorator metadata —
 * which guards a handler runs under, and which permission it names.
 */

let ctx: TestContext;

type DiscoveredRoute = {
  controller: string;
  handler: string;
  method: string;
  path: string;
  guards: string[];
  permissions: AdminPermission[];
  staffPermissions: AdminPermission[];
  roles: UserRole[];
};

const VERBS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

let routes: DiscoveredRoute[] = [];

beforeAll(async () => {
  ctx = await createTestApp();
  routes = discoverRoutes(ctx.app.get(ModulesContainer));
});

afterAll(async () => {
  await ctx.app.close();
});

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    typeof entry === 'function' ? entry.name : (entry?.constructor?.name ?? String(entry)),
  );
}

function discoverRoutes(container: ModulesContainer): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;

      const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const classGuards = names(Reflect.getMetadata(GUARDS_METADATA, controller));
      const classPermissions =
        (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, controller) as AdminPermission[]) ?? [];
      const classStaffPermissions =
        (Reflect.getMetadata(STAFF_PERMISSIONS_KEY, controller) as AdminPermission[]) ?? [];
      const classRoles = (Reflect.getMetadata(ROLES_KEY, controller) as UserRole[]) ?? [];

      const prototype = controller.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        if (key === 'constructor') continue;
        const handler = prototype[key];
        if (typeof handler !== 'function') continue;

        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const verb = Reflect.getMetadata(METHOD_METADATA, handler);
        if (sub === undefined || verb === undefined) continue;

        const methodGuards = names(Reflect.getMetadata(GUARDS_METADATA, handler));
        const methodPermissions =
          (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler) as AdminPermission[]) ?? [];
        const methodStaffPermissions =
          (Reflect.getMetadata(STAFF_PERMISSIONS_KEY, handler) as AdminPermission[]) ?? [];
        const methodRoles = (Reflect.getMetadata(ROLES_KEY, handler) as UserRole[]) ?? [];

        found.push({
          controller: controller.name,
          handler: key,
          method: VERBS[verb as number] ?? String(verb),
          path: joinPath(prefix, String(sub ?? '')),
          guards: [...classGuards, ...methodGuards],
          // A method's decorator overrides its class's, exactly as
          // `reflector.getAllAndOverride` resolves it at run time.
          permissions: methodPermissions.length > 0 ? methodPermissions : classPermissions,
          staffPermissions:
            methodStaffPermissions.length > 0 ? methodStaffPermissions : classStaffPermissions,
          roles: methodRoles.length > 0 ? methodRoles : classRoles,
        });
      }
    }
  }

  return found;
}

function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

describe('PR-0 route/permission map', () => {
  it('classifies every route that runs PermissionsGuard', () => {
    const mapped = new Set(ADMIN_ROUTE_PERMISSIONS.map(key));

    const unclassified = routes
      .filter((route) => route.guards.includes(PermissionsGuard.name))
      .filter((route) => route.permissions.length > 0)
      .filter((route) => !mapped.has(key(route)))
      .map((route) => `${key(route)} (${route.controller}.${route.handler})`);

    // This is the failure the whole exercise exists to produce: a new admin
    // route whose author never decided who may reach it.
    expect(unclassified).toEqual([]);
  });

  it('names no route that does not exist', () => {
    const live = new Set(routes.map(key));
    const dead = ADMIN_ROUTE_PERMISSIONS.map(key).filter((entry) => !live.has(entry));
    expect(dead).toEqual([]);
  });

  it('gives every mapped route the permission the map names', () => {
    const byKey = new Map(routes.map((route) => [key(route), route]));
    const mismatched: string[] = [];

    for (const entry of ADMIN_ROUTE_PERMISSIONS) {
      const route = byKey.get(key(entry));
      if (!route) continue;
      const declared = [...route.permissions, ...route.staffPermissions];
      if (!declared.includes(entry.permission)) {
        mismatched.push(`${key(entry)} → beklenen ${entry.permission}, bulunan ${declared.join(',') || '(yok)'}`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('runs AdminAccessGuard wherever it runs PermissionsGuard', () => {
    // PermissionsGuard says nothing about routes that name no permission, so a
    // permission-guarded route without the access guard would be open to any
    // signed-in customer the moment its permission list was emptied.
    const missing = routes
      .filter((route) => route.permissions.length > 0)
      .filter((route) => !route.guards.includes(AdminAccessGuard.name))
      .map((route) => `${key(route)} (${route.controller}.${route.handler})`);

    // `PATCH /providers/:id` is the deliberate exception: it serves providers
    // too, and asks for a permission only of staff callers (RG-7 §12.3).
    expect(missing).toEqual([]);
  });

  it('keeps the root routes on the role decorator and off the permission model', () => {
    const byKey = new Map(routes.map((route) => [key(route), route]));

    for (const root of ROOT_ONLY_ROUTES) {
      const route = byKey.get(key(root));
      expect(route, `${key(root)} bulunamadı`).toBeTruthy();
      expect(route!.roles, `${key(root)} SUPER_ADMIN rolüyle korunmalı`).toContain(
        UserRole.SUPER_ADMIN,
      );
      expect(route!.permissions, `${key(root)} bir izne bağlanmamalı`).toEqual([]);
    }
  });

  it('uses only catalogue values, and uses all of them', () => {
    const used = new Set(ADMIN_ROUTE_PERMISSIONS.map((entry) => entry.permission));
    const catalogue = new Set(ALL_ADMIN_PERMISSIONS);

    // Every value the map names is a real enum member…
    for (const permission of used) {
      expect(catalogue.has(permission)).toBe(true);
    }

    // …and every enum member guards something. A permission that guards nothing
    // is a box an operator can tick for no effect, which is exactly what the
    // closed catalogue exists to prevent.
    const unused = [...catalogue].filter((permission) => !used.has(permission));
    expect(unused).toEqual([]);
  });

  it('has no root capability among the catalogue values (I-1)', () => {
    // The database half of this is the enum itself; this is the half a reader
    // can see. `ADMIN_ROLES_MANAGE`, `ADMIN_USERS_CREATE` and
    // `ADMIN_INVITE_ISSUE` must not exist as permissions at all (RG-7 §12.1).
    const forbidden = ['ADMIN_ROLES_MANAGE', 'ADMIN_USERS_CREATE', 'ADMIN_INVITE_ISSUE'];
    const present = forbidden.filter((name) =>
      (ALL_ADMIN_PERMISSIONS as string[]).includes(name),
    );
    expect(present).toEqual([]);
    /*
     * A deliberately hard-coded count.
     *
     * Adding a permission is a decision about who may do what, and this line is
     * where that decision has to be typed out a second time. It is the reason
     * `CATALOG_READ` could not be added quietly: the number had to move, and
     * moving it meant naming the capability in a commit message.
     */
    expect(Object.keys(AdminPermission)).toHaveLength(82);
  });
});
