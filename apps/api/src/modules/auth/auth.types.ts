import { UserRole } from '@prisma/client';

export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: UserRole;
  isActive: boolean;
};
