import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

import { StateAvailabilityService } from './state-availability.service';
import { AdminRole } from '../admin-users/models/admin-user.model';
import { AdminJwtGuard } from '../common/guards/admin-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';

class UpsertStateRuleDto {
  @IsString()
  @Length(2, 2)
  declare state_code: string;

  @IsOptional()
  @IsBoolean()
  declare is_active?: boolean;

  @IsOptional()
  @IsString()
  declare license_number?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  declare max_loan_amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  declare max_apr?: number;

  @IsOptional()
  @IsString()
  declare disclosure_text?: string;

  @IsOptional()
  @IsBoolean()
  declare waitlist_only?: boolean;
}

@ApiTags('state-availability')
@Controller('states')
@UseGuards(AdminJwtGuard, RolesGuard)
export class StateAvailabilityController {
  constructor(private readonly stateService: StateAvailabilityService) {}

  /** Public so the application form can hide states the lender does not serve. */
  @Public()
  @ApiOperation({ summary: 'States currently open for applications' })
  @Get()
  async list() {
    return { states: await this.stateService.listActive() };
  }

  @ApiBearerAuth('admin-jwt')
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create or update a state lending rule' })
  @Put()
  async upsert(@Body() dto: UpsertStateRuleDto) {
    return { state: await this.stateService.upsertStateRule(dto) };
  }
}
