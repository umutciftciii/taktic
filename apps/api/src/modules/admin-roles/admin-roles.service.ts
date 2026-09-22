import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminPermission, AdminRoleAuditAction, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ALL_ADMIN_PERMISSIONS, STAFF_ROLES } from '../auth/admin-permissions';
import type { AuthUser } from '../auth/auth.types';
import {
  AssignAdminRoleDto,
  CreateAdminRoleDto,
  ReplaceAdminRolePermissionsDto,
  UpdateAdminRoleDto,
} from './dto/admin-role.dto';

/**
 * Roles, their permissions, and who holds them.
 *
 * Everything here is a **root** capability: only a SUPER_ADMIN reaches these
 * routes, and no permission value exists that could delegate them (RG-7
 * §12.1). That is the whole reason the module is small and blunt — a role that
 * could edit roles would be a role that could grant itself anything, so the
 * authority to define authority is deliberately not part of the model it
 * defines.
 *
 * Three rules run this file:
 *
 *  1. A role is never deleted, only deactivated. Assignments and audit rows
 *     point at it, and "who could do what last March" has to stay answerable.
 *     Deactivating is also how a capability is taken from everyone at once:
 *     the session's permission read filters on `role.isActive`.
 *
 *  2. A permission set is replaced whole, never patched. Two operators editing
 *     one role cannot interleave into a set neither chose, and one audit row
 *     says what the role holds now.
 *
 *  3. Every change writes an audit row in the same transaction as the change.
 *     There is no path that alters access without leaving a record, and the
 *     actor always comes from the session.
 */
@Injectable()
export class AdminRolesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The closed catalogue, for the screen that builds a role out of it. */
  listCatalogue() {
    return { permissions: [...ALL_ADMIN_PERMISSIONS] };
  }

  async list() {
    const roles = await this.prisma.adminRole.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        permissions: { select: { permission: true } },
        _count: { select: { assignments: { where: { revokedAt: null } } } },
      },
    });

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isActive: role.isActive,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
      permissions: role.permissions.map((p) => p.permission).sort(),
      activeAssignmentCount: role._count.assignments,
    }));
  }

  async detail(id: string) {
    const role = await this.prisma.adminRole.findUnique({
      where: { id },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        permissions: { select: { permission: true } },
        assignments: {
          where: { revokedAt: null },
          orderBy: { assignedAt: 'desc' },
          select: {
            id: true,
            assignedAt: true,
            user: { select: { id: true, name: true, email: true, role: true, isActive: true } },
          },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    return {
      ...role,
      permissions: role.permissions.map((p) => p.permission).sort(),
    };
  }

  async create(dto: CreateAdminRoleDto, actor: AuthUser) {
    const key = dto.key.trim();
    const name = dto.name.trim();
    const description = dto.description?.trim() || null;
    const permissions = dedupe(dto.permissions ?? []);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await tx.adminRole.create({
          data: {
            key,
            name,
            description,
            createdById: actor.id,
            permissions: { create: permissions.map((permission) => ({ permission })) },
          },
          select: { id: true, key: true, name: true, description: true, isActive: true },
        });

        await this.audit(tx, AdminRoleAuditAction.ROLE_CREATED, actor.id, {
          roleId: role.id,
          summary: { key, name, permissions },
        });

        return { ...role, permissions };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The key is unique and never reused, so this is not "try again" — it
        // is "that name is taken, including by a role somebody deactivated".
        throw new ConflictException('Bu rol anahtarı zaten kullanılıyor.');
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateAdminRoleDto, actor: AuthUser) {
    const existing = await this.prisma.adminRole.findUnique({
      where: { id },
      select: { id: true, key: true, name: true, description: true, isActive: true },
    });
    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    const data: Prisma.AdminRoleUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    if (Object.keys(data).length === 0) {
      return { ...existing };
    }

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.adminRole.update({
        where: { id },
        data,
        select: { id: true, key: true, name: true, description: true, isActive: true },
      });

      // Activation state is its own audit action, because it is the one edit
      // that changes what people can do rather than what the role is called.
      const action =
        dto.isActive === undefined
          ? AdminRoleAuditAction.ROLE_UPDATED
          : dto.isActive
            ? AdminRoleAuditAction.ROLE_REACTIVATED
            : AdminRoleAuditAction.ROLE_DEACTIVATED;

      await this.audit(tx, action, actor.id, {
        roleId: role.id,
        summary: {
          key: role.key,
          changed: Object.keys(data),
          isActive: role.isActive,
        },
      });

      return role;
    });
  }

  async replacePermissions(id: string, dto: ReplaceAdminRolePermissionsDto, actor: AuthUser) {
    const role = await this.prisma.adminRole.findUnique({
      where: { id },
      select: { id: true, key: true, permissions: { select: { permission: true } } },
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }

    const next = dedupe(dto.permissions);
    const previous = role.permissions.map((p) => p.permission).sort();
    const added = next.filter((p) => !previous.includes(p));
    const removed = previous.filter((p) => !next.includes(p));

    if (added.length === 0 && removed.length === 0) {
      return { id: role.id, permissions: previous };
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.adminRolePermission.deleteMany({ where: { roleId: id } });
      if (next.length > 0) {
        await tx.adminRolePermission.createMany({
          data: next.map((permission) => ({ roleId: id, permission })),
        });
      }
      await tx.adminRole.update({ where: { id }, data: { updatedAt: new Date() } });

      await this.audit(tx, AdminRoleAuditAction.ROLE_PERMISSIONS_REPLACED, actor.id, {
        roleId: id,
        summary: { key: role.key, added, removed, total: next.length },
      });

      return { id, permissions: next };
    });
  }

  async assign(userId: string, dto: AssignAdminRoleDto, actor: AuthUser) {
    const [target, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } }),
      this.prisma.adminRole.findUnique({ where: { id: dto.roleId }, select: { id: true, key: true, isActive: true } }),
    ]);

    if (!target || !STAFF_ROLES.includes(target.role)) {
      // 404 rather than 403 for the same reason the provider routes use it: a
      // different answer for "not staff" than for "no such account" would say
      // which customer ids exist.
      throw new NotFoundException('User not found');
    }
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('Süper admin zaten tüm izinlere sahiptir; rol atanamaz.');
    }
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (!role.isActive) {
      throw new ConflictException('Pasif bir rol atanamaz.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const assignment = await tx.adminRoleAssignment.create({
          data: { userId, roleId: role.id, assignedById: actor.id },
          select: { id: true, assignedAt: true },
        });

        await this.audit(tx, AdminRoleAuditAction.ASSIGNMENT_GRANTED, actor.id, {
          roleId: role.id,
          targetUserId: userId,
          summary: { key: role.key },
        });

        return { id: assignment.id, roleId: role.id, userId, assignedAt: assignment.assignedAt };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The partial unique index refused a second live assignment of the same
        // role; the operator's intent is already true.
        throw new ConflictException('Bu rol bu kullanıcıda zaten aktif.');
      }
      throw error;
    }
  }

  async revoke(userId: string, roleId: string, actor: AuthUser) {
    const role = await this.prisma.adminRole.findUnique({ where: { id: roleId }, select: { key: true } });

    return this.prisma.$transaction(async (tx) => {
      // Conditional on the assignment still being live, so two concurrent
      // revokes produce one revocation and one audit row rather than two.
      const updated = await tx.adminRoleAssignment.updateMany({
        where: { userId, roleId, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: actor.id },
      });

      if (updated.count === 0) {
        throw new NotFoundException('Assignment not found');
      }

      await this.audit(tx, AdminRoleAuditAction.ASSIGNMENT_REVOKED, actor.id, {
        roleId,
        targetUserId: userId,
        summary: { key: role?.key ?? null },
      });

      return { userId, roleId, revoked: true as const };
    });
  }

  /** Every role a staff account holds, live and revoked, newest first. */
  async listForUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user || !STAFF_ROLES.includes(user.role)) {
      throw new NotFoundException('User not found');
    }

    const assignments = await this.prisma.adminRoleAssignment.findMany({
      where: { userId },
      orderBy: [{ revokedAt: 'asc' }, { assignedAt: 'desc' }],
      select: {
        id: true,
        assignedAt: true,
        revokedAt: true,
        role: {
          select: { id: true, key: true, name: true, isActive: true, permissions: { select: { permission: true } } },
        },
      },
    });

    return {
      userId,
      role: user.role,
      isSuperAdmin: user.role === UserRole.SUPER_ADMIN,
      assignments: assignments.map((a) => ({
        id: a.id,
        assignedAt: a.assignedAt,
        revokedAt: a.revokedAt,
        role: {
          id: a.role.id,
          key: a.role.key,
          name: a.role.name,
          isActive: a.role.isActive,
          permissions: a.role.permissions.map((p) => p.permission).sort(),
        },
      })),
    };
  }

  private audit(
    tx: Prisma.TransactionClient,
    action: AdminRoleAuditAction,
    actorId: string,
    fields: { roleId?: string | null; targetUserId?: string | null; summary: Prisma.InputJsonValue },
  ) {
    return tx.adminRoleAuditLog.create({
      data: {
        action,
        actorId,
        roleId: fields.roleId ?? null,
        targetUserId: fields.targetUserId ?? null,
        summary: fields.summary,
      },
      select: { id: true },
    });
  }
}

function dedupe(permissions: readonly AdminPermission[]): AdminPermission[] {
  return [...new Set(permissions)].sort();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
