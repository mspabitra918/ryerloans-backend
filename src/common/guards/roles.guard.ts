import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AdminRole } from '../../admin-users/models/admin-user.model';
import type { AuthenticatedAdmin } from '../../auth/auth.types';

/**
 * Enforces the §8.1 role matrix. Runs after AdminJwtGuard, so `request.admin`
 * is already populated; a route with no @Roles() is open to any authenticated
 * admin.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { admin?: AuthenticatedAdmin }>();

    const role = request.admin?.role;

    if (!role || !required.includes(role)) {
      throw new ForbiddenException(
        `This action requires one of: ${required.join(', ')}`,
      );
    }

    return true;
  }
}
