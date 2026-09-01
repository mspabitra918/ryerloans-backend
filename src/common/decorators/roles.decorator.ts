import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '../../admin-users/models/admin-user.model';

export const ROLES_KEY = 'admin_roles';

/**
 * Restrict a route to the §8.1 roles listed.
 *
 * Absence of the decorator means "any authenticated admin", which is why the
 * guard is applied globally to the admin controllers rather than per-route:
 * forgetting @Roles() should under-privilege nobody, but forgetting the guard
 * entirely would expose the route to the public.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);
