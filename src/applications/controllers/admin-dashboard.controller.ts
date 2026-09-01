import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { ApplicationDashboardService } from '../services/application-dashboard.service';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DASHBOARD_RANGES, type DashboardRange } from '../application.types';

/** §8.5 dashboard. Readable by every signed-in role, including read_only. */
@ApiTags('admin-dashboard')
@ApiBearerAuth('admin-jwt')
@Controller('admin/dashboard')
@UseGuards(AdminJwtGuard, RolesGuard)
export class AdminDashboardController {
  constructor(private readonly dashboardService: ApplicationDashboardService) {}

  @ApiOperation({ summary: 'Dashboard roll-up' })
  @ApiQuery({
    name: 'range',
    required: false,
    enum: DASHBOARD_RANGES as unknown as string[],
    description:
      'Cohort window for the funnel, performance, breakdown and email blocks ' +
      '(default "all"). The applications today/week/month tiles ignore it.',
  })
  @Get()
  stats(@Query('range') range?: string) {
    // Rejected rather than silently coerced to "all": a typo'd range would
    // otherwise show lifetime numbers under a "Today" heading.
    if (range && !DASHBOARD_RANGES.includes(range as DashboardRange)) {
      throw new BadRequestException(
        `range must be one of: ${DASHBOARD_RANGES.join(', ')}`,
      );
    }

    return this.dashboardService.stats((range as DashboardRange) ?? 'all');
  }
}
