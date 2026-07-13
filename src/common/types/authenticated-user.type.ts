import type { UserRole } from '../../generated/prisma-client/enums';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  sessionId: string;
  tokenVersion: number;
}
