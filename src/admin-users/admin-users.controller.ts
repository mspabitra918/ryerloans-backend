import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

import { AdminUsersService } from './admin-users.service';
import { AdminRole } from './models/admin-user.model';
import { RoleMatrix } from '../common/roles/role-matrix';
import { CreateAdminUserDto, UpdateAdminUserDto } from '../auth/dto/auth.dto';
import { AdminJwtGuard } from '../common/guards/admin-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

class ResetPasswordDto {
  @IsString()
  @MinLength(12)
  declare password: string;
}

/**
 * §8.1: "super_admin (all + user management)". Every route here is user
 * management, so the role restriction sits on the controller rather than being
 * repeated — a new route added below is locked down by default.
 */
@ApiTags('admin-users')
@ApiBearerAuth('admin-jwt')
@Controller('admin/users')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles(...RoleMatrix.manageUsers)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @ApiOperation({ summary: 'List admin users' })
  @Get()
  async list() {
    return { users: await this.adminUsersService.list() };
  }

  @ApiOperation({ summary: 'Create an admin user' })
  @Post()
  async create(@Body() dto: CreateAdminUserDto) {
    return {
      user: await this.adminUsersService.create({
        email: dto.email,
        password: dto.password,
        role: dto.role as AdminRole,
        login_id: dto.login_id,
      }),
    };
  }

  @ApiOperation({ summary: 'Change role or active state' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminUserDto,
  ) {
    return {
      user: await this.adminUsersService.update(id, {
        role: dto.role as AdminRole | undefined,
        is_active: dto.is_active,
      }),
    };
  }

  @ApiOperation({ summary: 'Clear a failed-attempt lockout' })
  @Patch(':id/unlock')
  async unlock(@Param('id', ParseUUIDPipe) id: string) {
    return { user: await this.adminUsersService.unlock(id) };
  }

  @ApiOperation({ summary: 'Reset TOTP so the next sign-in re-enrolls' })
  @Patch(':id/mfa/reset')
  async resetMfa(@Param('id', ParseUUIDPipe) id: string) {
    return { user: await this.adminUsersService.resetMfa(id) };
  }

  @ApiOperation({ summary: 'Set a new password for an admin user' })
  @Patch(':id/password')
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return {
      user: await this.adminUsersService.resetPassword(id, dto.password),
    };
  }
}
