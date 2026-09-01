import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import * as bcrypt from 'bcrypt';

import { AdminRole, AdminUser } from './models/admin-user.model';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';

/** The public shape of an admin user — never carries the hash or TOTP secret. */
export interface AdminUserView {
  id: string;
  login_id: string;
  email: string;
  role: AdminRole;
  mfa_enabled: boolean;
  is_active: boolean;
  last_login_at: Date | null;
  last_login_ip: string | null;
  locked_until: Date | null;
  created_at: Date | null;
}

/**
 * §8.1 user management, restricted to super_admin by the controller.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @InjectModel(AdminUser) private readonly adminUserModel: typeof AdminUser,
    private readonly sessionService: SessionService,
  ) {}

  static toView(user: AdminUser): AdminUserView {
    return {
      id: user.id,
      login_id: user.login_id,
      email: user.email,
      role: user.role,
      mfa_enabled: user.mfa_enabled,
      is_active: user.is_active,
      last_login_at: user.last_login_at ?? null,
      last_login_ip: user.last_login_ip ?? null,
      locked_until: user.locked_until ?? null,
      created_at: (user as unknown as { created_at?: Date }).created_at ?? null,
    };
  }

  async list(): Promise<AdminUserView[]> {
    const users = await this.adminUserModel.findAll({
      order: [
        ['is_active', 'DESC'],
        ['email', 'ASC'],
      ],
    });

    return users.map((user) => AdminUsersService.toView(user));
  }

  async findOrFail(id: string): Promise<AdminUser> {
    const user = await this.adminUserModel.findByPk(id);

    if (!user) throw new NotFoundException('Admin user not found');

    return user;
  }

  async create(data: {
    email: string;
    password: string;
    role: AdminRole;
    login_id?: string;
  }): Promise<AdminUserView> {
    const email = data.email.trim().toLowerCase();

    if (await this.adminUserModel.findOne({ where: { email } })) {
      throw new BadRequestException('Email already registered');
    }

    const user = await this.adminUserModel.create({
      login_id: data.login_id ?? AuthService.generateLoginId(),
      email,
      password_hash: await bcrypt.hash(data.password, 12),
      role: data.role,
    });

    return AdminUsersService.toView(user);
  }

  /**
   * A role change or deactivation must take effect immediately, so both
   * revoke the account's live sessions — the role is baked into the JWT and
   * would otherwise stay stale until the token expired.
   */
  async update(
    id: string,
    changes: { role?: AdminRole; is_active?: boolean },
  ): Promise<AdminUserView> {
    const user = await this.findOrFail(id);

    const roleChanged =
      changes.role !== undefined && changes.role !== user.role;
    const deactivated = changes.is_active === false && user.is_active;

    await user.update({
      ...(changes.role !== undefined ? { role: changes.role } : {}),
      ...(changes.is_active !== undefined
        ? { is_active: changes.is_active }
        : {}),
    });

    if (roleChanged || deactivated) {
      await this.sessionService.revokeAllForUser(
        user.id,
        deactivated ? 'account_deactivated' : 'role_changed',
      );
    }

    return AdminUsersService.toView(user);
  }

  /** Clears a §8.1 lockout without waiting out the 15-minute window. */
  async unlock(id: string): Promise<AdminUserView> {
    const user = await this.findOrFail(id);

    await user.update({ failed_attempts: 0, locked_until: null });

    return AdminUsersService.toView(user);
  }

  /**
   * Drop the TOTP secret so the next sign-in re-enrolls. Used when an admin
   * loses their device — without it the account is permanently unreachable.
   */
  async resetMfa(id: string): Promise<AdminUserView> {
    const user = await this.findOrFail(id);

    await user.update({ mfa_secret: null, mfa_enabled: false });
    await this.sessionService.revokeAllForUser(user.id, 'mfa_reset');

    return AdminUsersService.toView(user);
  }

  async resetPassword(id: string, newPassword: string): Promise<AdminUserView> {
    const user = await this.findOrFail(id);

    await user.update({
      password_hash: await bcrypt.hash(newPassword, 12),
      failed_attempts: 0,
      locked_until: null,
    });

    await this.sessionService.revokeAllForUser(user.id, 'password_reset');

    return AdminUsersService.toView(user);
  }

  /** Assignable agents for the §8.2 "assigned agent" filter. */
  async listAssignable(): Promise<
    Array<{ id: string; email: string; role: AdminRole }>
  > {
    const users = await this.adminUserModel.findAll({
      where: { is_active: true },
      order: [['email', 'ASC']],
    });

    return users
      .filter((user) => user.role !== AdminRole.READ_ONLY)
      .map((user) => ({ id: user.id, email: user.email, role: user.role }));
  }
}
