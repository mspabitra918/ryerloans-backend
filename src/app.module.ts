import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { SequelizeModule } from '@nestjs/sequelize';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { ApplicationsModule } from './applications/applications.module';
import { PlaidModule } from './plaid/plaid.module';
import { DocumentsModule } from './documents/documents.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { EmailModule } from './email/email.module';
import { EmailSequenceModule } from './email-sequence/email-sequence.module';
import { ReviewInvitationModule } from './review-invitation/review-invitations.module';
import { StateAvailabilityModule } from './state-availability/state-availability.module';
import { DripModule } from './queue/drip/drip.module';
import { getRedisOptions } from './queue/redis/redis.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    SequelizeModule.forRoot({
      dialect: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      // .env defines DB_USERNAME/DB_PASSWORD; DB_USER is accepted as an alias.
      username: process.env.DB_USERNAME || process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'ryerloans',
      dialectOptions:
        process.env.DB_SSL === 'true'
          ? { ssl: { require: true, rejectUnauthorized: false } }
          : {},
      // Models are registered by their owning feature modules via
      // SequelizeModule.forFeature(); autoLoadModels picks them up from there.
      autoLoadModels: true,
      synchronize: false,

      // Disable Sequelize SQL query logs
      logging: false,
    }),

    /*
     * Baseline rate limit for every route. The admin sign-in and the borrower
     * intake and status endpoints override it with tighter buckets of their
     * own — this is the floor, not the policy.
     */
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    // Backs the §7 drip queue.
    BullModule.forRoot({ connection: getRedisOptions() }),

    // Drives the 45-day expiry sweep.
    ScheduleModule.forRoot(),

    CommonModule,
    AuthModule,
    AdminUsersModule,
    AuditLogModule,
    ApplicationsModule,
    PlaidModule,
    DocumentsModule,
    EmailModule,
    EmailSequenceModule,
    ReviewInvitationModule,
    StateAvailabilityModule,
    DripModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    // Applied globally so a new controller is rate-limited by default rather
    // than by remembering to decorate it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
