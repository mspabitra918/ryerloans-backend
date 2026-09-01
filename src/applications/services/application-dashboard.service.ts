import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { Op, QueryTypes } from 'sequelize';

import { Application } from '../models/application.model';
import { ApplicationStatus } from '../dto/application-enums';
import {
  ADMIN_TIMEZONE,
  DASHBOARD_RANGES,
  ECOA_REASON_CODES,
  type DashboardRange,
} from '../application.types';
import { humanizeStatus } from '../application-status.machine';
import { EmailLogService } from '../../email-log/email-log.service';

export { DASHBOARD_RANGES };

/**
 * Raw shape of the single aggregate query behind the dashboard. Postgres hands
 * back `numeric` as a string, hence the widened types on the averages.
 */
interface DashboardCoreRow {
  received: number;
  called_in: number;
  bank_verified: number;
  agreement_sent: number;
  agreement_signed: number;
  deposit_sent: number;
  deposit_confirmed: number;
  approved: number;
  funded: number;
  declined: number;
  withdrawn: number;
  expired: number;
  duplicates: number;
  open_duplicates: number;
  called_in_within_24h: number;
  called_in_24h_eligible: number;
  avg_seconds_to_fund: string | null;
  median_seconds_to_fund: string | null;
}

/**
 * §8.5 admin dashboard.
 *
 * The cohort blocks are single grouped/filtered aggregates rather than a
 * fan-out of `count()` calls — the funnel alone would otherwise be nine table
 * scans. The header tiles are the exception: four plain counts, kept on the ORM
 * since they carry no per-row logic.
 */
@Injectable()
export class ApplicationDashboardService {
  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly emailLogService: EmailLogService,
  ) {}

  /**
   * @param range Cohort window applied to every block except `applications`,
   *   which always reports today/week/month so the header tiles never move.
   *   Day boundaries are the lender's own (see ADMIN_TIMEZONE), so "today"
   *   means the same thing here as it does in the applications list.
   */
  async stats(range: DashboardRange = 'all') {
    const sequelize = this.applicationModel.sequelize;

    if (!sequelize) {
      throw new InternalServerErrorException(
        'Application model is not bound to a Sequelize instance',
      );
    }

    const now = new Date();
    const boundaries = this.getAdminDayBoundaries(now);
    const rangeStart = this.resolveRangeStart(range, boundaries);

    // Inlined into every cohort query below; NULL means "lifetime".
    const rangeClause = `(
      CAST(:rangeStart AS timestamptz) IS NULL
      OR created_at >= CAST(:rangeStart AS timestamptz)
    )`;
    const replacements = { rangeStart };

    const [
      [total, today, week, month],
      [core],
      declineReasonRows,
      stateRows,
      sourceRows,
      statusRows,
      agentRows,
      email,
    ] = await Promise.all([
      // Header tiles — deliberately unfiltered by `range`. Nested so the four
      // counts still run alongside the cohort queries rather than after them.
      Promise.all([
        this.applicationModel.count(),
        this.applicationModel.count({
          where: { created_at: { [Op.gte]: boundaries.startOfToday } },
        }),
        this.applicationModel.count({
          where: { created_at: { [Op.gte]: boundaries.startOfWeek } },
        }),
        this.applicationModel.count({
          where: { created_at: { [Op.gte]: boundaries.startOfMonth } },
        }),
      ]),

      // Funnel, outcomes, SLA and time-to-fund in one pass over the cohort.
      //
      // Stages are measured on the milestone timestamps, not on `status`:
      // status only ever holds where a file is *now*, so a funded loan would
      // otherwise read as never having been called in or bank verified.
      sequelize.query<DashboardCoreRow>(
        `
          SELECT
            COUNT(*)::int AS received,
            COUNT(*) FILTER (WHERE called_in)::int AS called_in,
            COUNT(*) FILTER (WHERE bank_verified)::int AS bank_verified,
            COUNT(*) FILTER (
              WHERE agreement_sent_at IS NOT NULL
            )::int AS agreement_sent,
            COUNT(*) FILTER (
              WHERE agreement_signed_at IS NOT NULL
            )::int AS agreement_signed,
            COUNT(*) FILTER (
              WHERE micro_deposit_sent_at IS NOT NULL
            )::int AS deposit_sent,
            COUNT(*) FILTER (
              WHERE micro_deposit_confirmed_at IS NOT NULL
                OR micro_deposit_conf_at IS NOT NULL
            )::int AS deposit_confirmed,
            -- Both the decision column and the status are accepted for the
            -- terminal stages: they are written together by the admin
            -- actions, but a file migrated or corrected by hand may carry
            -- only one and must not vanish from the funnel.
            COUNT(*) FILTER (
              WHERE decision = 'approved' OR status IN ('approved', 'funded')
            )::int AS approved,
            COUNT(*) FILTER (
              WHERE funded_at IS NOT NULL OR status = 'funded'
            )::int AS funded,

            COUNT(*) FILTER (
              WHERE decision = 'declined' OR status = 'declined'
            )::int AS declined,
            COUNT(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn,
            COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,

            COUNT(*) FILTER (WHERE possible_duplicate)::int AS duplicates,
            COUNT(*) FILTER (
              WHERE possible_duplicate
                AND status NOT IN ('funded', 'declined', 'withdrawn', 'expired')
            )::int AS open_duplicates,

            COUNT(*) FILTER (
              WHERE called_in_at IS NOT NULL
                AND called_in_at <= created_at + INTERVAL '24 hours'
            )::int AS called_in_within_24h,
            -- Only files whose 24h clock has actually run out can fail the
            -- SLA; anything younger is still in flight and would drag the
            -- rate down for no reason.
            COUNT(*) FILTER (
              WHERE created_at <= NOW() - INTERVAL '24 hours'
                OR (
                  called_in_at IS NOT NULL
                  AND called_in_at <= created_at + INTERVAL '24 hours'
                )
            )::int AS called_in_24h_eligible,

            AVG(
              EXTRACT(EPOCH FROM (funded_at - created_at))
            ) AS avg_seconds_to_fund,
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (funded_at - created_at))
            ) AS median_seconds_to_fund
          FROM applications
          WHERE ${rangeClause}
        `,
        { replacements, type: QueryTypes.SELECT },
      ),

      // decline_reason_codes is text[]; unnest to count each ECOA code.
      sequelize.query<{ code: string; count: number }>(
        `
          SELECT code, COUNT(*)::int AS count
          FROM applications, LATERAL unnest(decline_reason_codes) AS code
          WHERE ${rangeClause}
          GROUP BY code
          ORDER BY count DESC, code ASC
        `,
        { replacements, type: QueryTypes.SELECT },
      ),

      sequelize.query<{ state: string; count: number }>(
        `
          SELECT state, COUNT(*)::int AS count
          FROM applications
          WHERE ${rangeClause} AND state IS NOT NULL
          GROUP BY state
          ORDER BY count DESC, state ASC
        `,
        { replacements, type: QueryTypes.SELECT },
      ),

      // No utm_source means the borrower arrived without campaign tagging.
      sequelize.query<{ source: string; count: number }>(
        `
          SELECT
            COALESCE(NULLIF(TRIM(utm_source), ''), 'direct') AS source,
            COUNT(*)::int AS count
          FROM applications
          WHERE ${rangeClause}
          GROUP BY 1
          ORDER BY count DESC, source ASC
        `,
        { replacements, type: QueryTypes.SELECT },
      ),

      sequelize.query<{ status: string; count: number }>(
        `
          SELECT status::text AS status, COUNT(*)::int AS count
          FROM applications
          WHERE ${rangeClause}
          GROUP BY status
        `,
        { replacements, type: QueryTypes.SELECT },
      ),

      // Open workload per agent, so the queue board shows who is carrying it.
      sequelize.query<{
        admin_user_id: string | null;
        email: string | null;
        open: number;
        total: number;
      }>(
        `
          SELECT
            a.assigned_agent_id AS admin_user_id,
            u.email,
            COUNT(*) FILTER (
              WHERE a.status NOT IN ('funded', 'declined', 'withdrawn', 'expired')
            )::int AS open,
            COUNT(*)::int AS total
          FROM applications a
          LEFT JOIN admin_users u ON u.id = a.assigned_agent_id
          WHERE ${rangeClause.replace(/created_at/g, 'a.created_at')}
          GROUP BY a.assigned_agent_id, u.email
          ORDER BY open DESC NULLS LAST
        `,
        { replacements, type: QueryTypes.SELECT },
      ),

      this.emailLogService.getDeliveryStats(rangeStart),
    ]);

    const received = Number(core?.received ?? 0);
    const declined = Number(core?.declined ?? 0);

    const statusCounts = new Map(
      statusRows.map((row) => [row.status, Number(row.count)]),
    );

    return {
      generated_at: now.toISOString(),
      timezone: ADMIN_TIMEZONE,

      range: {
        key: range,
        start: rangeStart ? rangeStart.toISOString() : null,
        end: now.toISOString(),
      },

      applications: { today, week, month, total },

      funnel: this.buildFunnel(core),

      outcomes: {
        approved: Number(core?.approved ?? 0),
        funded: Number(core?.funded ?? 0),
        declined,
        withdrawn: Number(core?.withdrawn ?? 0),
        expired: Number(core?.expired ?? 0),
      },

      performance: {
        called_in_within_24h_percent: this.percent(
          core?.called_in_within_24h,
          core?.called_in_24h_eligible,
        ),
        called_in_within_24h: Number(core?.called_in_within_24h ?? 0),
        // Files still inside their 24h window are excluded from the rate
        // above, so surface the denominator rather than leaving it implicit.
        called_in_24h_eligible: Number(core?.called_in_24h_eligible ?? 0),

        called_in_percent: this.percent(core?.called_in, received),
        bank_verified_percent: this.percent(core?.bank_verified, received),

        average_time_to_fund_hours: this.secondsToHours(
          core?.avg_seconds_to_fund,
        ),
        median_time_to_fund_hours: this.secondsToHours(
          core?.median_seconds_to_fund,
        ),
        funded_count: Number(core?.funded ?? 0),
      },

      // An application can carry several ECOA codes, so these sum to >= the
      // declined count and the percentage is "share of declined files".
      decline_reasons: declineReasonRows.map((row) => ({
        code: row.code,
        label: ECOA_REASON_CODES[row.code] ?? row.code,
        count: Number(row.count),
        percent: this.percent(row.count, declined),
      })),

      applications_by_state: stateRows.map((row) => ({
        state: row.state,
        count: Number(row.count),
        percent: this.percent(row.count, received),
      })),

      traffic_sources: sourceRows.map((row) => ({
        source: row.source,
        count: Number(row.count),
        percent: this.percent(row.count, received),
      })),

      // Zero-filled and ordered by the pipeline, so an empty queue still
      // renders its tile instead of disappearing from the board.
      queues: Object.values(ApplicationStatus).map((status) => ({
        status,
        label: humanizeStatus(status),
        count: statusCounts.get(status) ?? 0,
      })),

      agent_workload: agentRows.map((row) => ({
        admin_user_id: row.admin_user_id,
        email: row.email ?? 'Unassigned',
        open: Number(row.open),
        total: Number(row.total),
      })),

      flagged_duplicates: {
        total: Number(core?.duplicates ?? 0),
        // Still actionable — the rest were already resolved one way or another.
        open: Number(core?.open_duplicates ?? 0),
      },

      email,
    };
  }

  /**
   * Ordered funnel with both step-over-step and top-of-funnel conversion.
   *
   * Stages are not strictly nested — a file can be funded without a micro
   * deposit ever being recorded — so a step can exceed 100%. That is real
   * signal about the pipeline and is reported rather than clamped.
   */
  private buildFunnel(core: DashboardCoreRow | undefined) {
    const stages: Array<{ stage: string; label: string; count: number }> = [
      {
        stage: 'received',
        label: 'Received',
        count: Number(core?.received ?? 0),
      },
      {
        stage: 'called_in',
        label: 'Called In',
        count: Number(core?.called_in ?? 0),
      },
      {
        stage: 'bank_verified',
        label: 'Bank Verified',
        count: Number(core?.bank_verified ?? 0),
      },
      {
        stage: 'agreement_sent',
        label: 'Agreement Sent',
        count: Number(core?.agreement_sent ?? 0),
      },
      {
        stage: 'agreement_signed',
        label: 'Agreement Signed',
        count: Number(core?.agreement_signed ?? 0),
      },
      {
        stage: 'deposit_sent',
        label: 'Verification Deposit Sent',
        count: Number(core?.deposit_sent ?? 0),
      },
      {
        stage: 'deposit_confirmed',
        label: 'Verification Deposit Confirmed',
        count: Number(core?.deposit_confirmed ?? 0),
      },
      {
        stage: 'approved',
        label: 'Approved',
        count: Number(core?.approved ?? 0),
      },
      { stage: 'funded', label: 'Funded', count: Number(core?.funded ?? 0) },
    ];

    const top = stages[0].count;

    return stages.map((stage, index) => ({
      ...stage,
      conversion_from_previous_percent:
        index === 0 ? 100 : this.percent(stage.count, stages[index - 1].count),
      conversion_from_received_percent: this.percent(stage.count, top),
      drop_off_from_previous:
        index === 0 ? 0 : Math.max(stages[index - 1].count - stage.count, 0),
    }));
  }

  /**
   * Start of today / this week (Monday) / this month, as UTC instants derived
   * from wall-clock time in ADMIN_TIMEZONE.
   */
  private getAdminDayBoundaries(now: Date) {
    const zonedNow = toZonedTime(now, ADMIN_TIMEZONE);

    const startOfWeekZoned = new Date(zonedNow);
    const weekday = startOfWeekZoned.getDay(); // 0 = Sunday
    startOfWeekZoned.setDate(
      startOfWeekZoned.getDate() - (weekday === 0 ? 6 : weekday - 1),
    );

    const startOfMonthZoned = new Date(zonedNow);
    startOfMonthZoned.setDate(1);

    return {
      startOfToday: this.zonedDayStart(zonedNow),
      startOfWeek: this.zonedDayStart(startOfWeekZoned),
      startOfMonth: this.zonedDayStart(startOfMonthZoned),
    };
  }

  /**
   * Midnight of the given zoned wall-clock date, back as a UTC instant.
   *
   * `zoned` carries admin-timezone wall time in its *local* getters, so the
   * calendar fields are read off directly and re-anchored — formatting it
   * would convert a second time and shift the boundary.
   */
  private zonedDayStart(zoned: Date): Date {
    const year = zoned.getFullYear();
    const month = `${zoned.getMonth() + 1}`.padStart(2, '0');
    const day = `${zoned.getDate()}`.padStart(2, '0');

    return fromZonedTime(
      `${year}-${month}-${day}T00:00:00.000`,
      ADMIN_TIMEZONE,
    );
  }

  private resolveRangeStart(
    range: DashboardRange,
    boundaries: ReturnType<
      ApplicationDashboardService['getAdminDayBoundaries']
    >,
  ): Date | null {
    switch (range) {
      case 'today':
        return boundaries.startOfToday;
      case 'week':
        return boundaries.startOfWeek;
      case 'month':
        return boundaries.startOfMonth;
      default:
        return null;
    }
  }

  /**
   * Two-decimal percentage, or null when the denominator is zero.
   *
   * Null rather than 0: an empty denominator means the ratio is undefined, and
   * a funnel step that reports "0%" off a zero-count predecessor reads as a
   * measured collapse instead of "nothing to measure yet".
   */
  private percent(
    part: number | string | null | undefined,
    whole: number | string | null | undefined,
  ): number | null {
    const denominator = Number(whole ?? 0);

    if (!denominator || !Number.isFinite(denominator)) return null;

    return Number(((Number(part ?? 0) / denominator) * 100).toFixed(2));
  }

  /**
   * Postgres returns AVG/PERCENTILE_CONT as a numeric string, and NULL when no
   * row qualified — an empty cohort must read as "no data", not as zero hours.
   */
  private secondsToHours(seconds: number | string | null | undefined) {
    if (seconds === null || seconds === undefined) return null;

    const value = Number(seconds);
    if (!Number.isFinite(value)) return null;

    return Number((value / 3600).toFixed(2));
  }
}
