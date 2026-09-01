import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { getClientIp } from '../utils/get-client-ip';
import { SessionService } from '../../auth/session.service';
import type {
  AdminJwtPayload,
  AuthenticatedAdmin,
} from '../../auth/auth.types';

/**
 * Authenticates an admin request and enforces the §8.1 session rules.
 *
 * Verifying the JWT is only half the job — a valid signature says nothing about
 * whether the session has idled out, been revoked, or is being replayed from a
 * different address. Those live on the session row, so every request pays one
 * primary-key read to check them.
 */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly sessionService: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { admin?: AuthenticatedAdmin }>();

    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing admin credentials');
    }

    let payload: AdminJwtPayload;

    try {
      payload = await this.jwtService.verifyAsync<AdminJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // An MFA challenge token carries `purpose` and no `sid`; it must never be
    // accepted as an access token.
    if (!payload?.sub || !payload.sid) {
      throw new UnauthorizedException('Invalid token');
    }

    const ipAddress = getClientIp(request);

    await this.sessionService.touch({
      sessionId: payload.sid,
      adminUserId: payload.sub,
      ipAddress,
    });

    request.admin = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      sessionId: payload.sid,
      ipAddress,
    };

    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;

    if (!header) return null;

    const [scheme, value] = header.split(' ');

    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
