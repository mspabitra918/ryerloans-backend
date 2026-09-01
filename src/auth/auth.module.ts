import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SequelizeModule } from '@nestjs/sequelize';

import { AdminUser } from '../admin-users/models/admin-user.model';
import { AdminSession } from './models/admin-session.model';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { AdminJwtGuard } from '../common/guards/admin-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';

/**
 * Global so every feature module can apply AdminJwtGuard without re-importing
 * JwtModule and SessionService. The guards are stateless; the session state
 * they consult lives in the database.
 */
@Global()
@Module({
  imports: [
    SequelizeModule.forFeature([AdminUser, AdminSession]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionService, AdminJwtGuard, RolesGuard],
  exports: [AuthService, SessionService, JwtModule, AdminJwtGuard, RolesGuard],
})
export class AuthModule {}
