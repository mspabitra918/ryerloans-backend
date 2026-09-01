import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { fromZonedTime } from 'date-fns-tz';
import { Op, literal, type Includeable, type WhereOptions } from 'sequelize';

import { Application } from '../models/application.model';
import { AdminUser } from '../../admin-users/models/admin-user.model';
import { ApplicationStatus } from '../dto/application-enums';
import { ADMIN_TIMEZONE } from '../application.types';
import { humanizeStatus } from '../application-status.machine';
import { maskAccount, maskSsn, formatPhone } from '../../common/pii/mask.util';
import type { SearchApplicationsDto } from '../dto/search-applications.dto';

/**
 * What the single §8.2 search box decided the input was. Surfaced to the client
 * so the UI can say "matched on phone" rather than leaving the admin guessing
 * why a result set looks the way it does.
 */
export type SearchKind =
  'application_id' | 'email' | 'phone' | 'ssn_last4' | 'name' | 'none';

export interface SearchResultRow {
  id: string;
  application_id: string;
  status: ApplicationStatus;
  status_label: string;
  full_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  state: string;
  amount_requested: number;
  loan_purpose: string;
  /** Masked; §8.3's Reveal control is the only path to the full value. */
  ssn_masked: string | null;
  account_masked: string | null;
  called_in: boolean;
  bank_verified: boolean;
  possible_duplicate: boolean;
  assigned_agent: { id: string; email: string } | null;
  utm_source: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface SearchResponse {
  results: SearchResultRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  /** Set when the query was an exact application id — the UI jumps straight in. */
  exact_match: string | null;
  detected: SearchKind;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Amount bands offered by the §8.2 filter bar, in dollars. */
export const AMOUNT_BANDS: Record<string, [number, number | null]> = {
  '0-1000': [0, 1000],
  '1000-2500': [1000, 2500],
  '2500-5000': [2500, 5000],
  '5000-10000': [5000, 10000],
  '10000+': [10000, null],
};

/**
 * §8.2 search and filtering.
 *
 * The previous implementation ran one ILIKE '%term%' across seven columns for
 * every keystroke and then decrypted the SSN, driver's licence, routing and
 * account numbers of every row it returned. Both are fixed here: the input type
 * is detected first so each query hits exactly one index, and the list never
 * decrypts anything — masked values come from the plaintext last-4 columns
 * that already exist for this purpose.
 */
@Injectable()
export class ApplicationSearchService {
  constructor(
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
  ) {}

  async search(filters: SearchApplicationsDto): Promise<SearchResponse> {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(
      Math.max(filters.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const term = filters.q?.trim() ?? '';
    const detected = ApplicationSearchService.detect(term);

    const conditions: WhereOptions[] = [];

    const searchClause = this.buildSearchClause(term, detected);
    if (searchClause) conditions.push(searchClause);

    conditions.push(...this.buildFilterClauses(filters));

    const where: WhereOptions =
      conditions.length > 0 ? ({ [Op.and]: conditions } as WhereOptions) : {};

    const include: Includeable[] = [
      {
        model: AdminUser,
        as: 'assigned_agent',
        attributes: ['id', 'email'],
        required: false,
      },
    ];

    const { rows, count } = await this.applicationModel.findAndCountAll({
      where,
      include,
      order: [['created_at', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      // The include is a LEFT JOIN on a single row; without this Sequelize
      // counts joined rows and reports inflated totals once more joins land.
      distinct: true,
    });

    return {
      results: rows.map((row) => ApplicationSearchService.toRow(row)),
      total: count,
      page,
      limit,
      pages: Math.max(Math.ceil(count / limit), 1),
      exact_match:
        detected === 'application_id' && rows.length === 1
          ? rows[0].application_id
          : null,
      detected,
    };
  }

  /**
   * §8.2: "Single search box, auto-detects input type".
   *
   * Order matters. An @ is unambiguous, and six digits is the application id
   * format — but a bare four digits is checked against SSN last-4 before names,
   * since no name is numeric.
   */
  static detect(term: string): SearchKind {
    const value = term.trim();

    if (!value) return 'none';
    if (value.includes('@')) return 'email';

    const digits = value.replace(/\D/g, '');
    const isAllDigits = digits.length === value.length;

    // A 6-character alphanumeric token with no spaces is an application id.
    if (/^[0-9A-Z]{6}$/i.test(value)) {
      return isAllDigits && digits.length === 6
        ? 'application_id'
        : 'application_id';
    }

    if (isAllDigits) {
      if (digits.length === 4) return 'ssn_last4';
      // 7 digits is the local part of a US number; the brief calls for
      // last-7-digit partials to match.
      if (digits.length >= 7) return 'phone';
      return 'phone';
    }

    // Mixed input with enough digits to be a formatted phone number:
    // (747) 200-5220, 747.200.5220, +1 747 200 5220.
    if (digits.length >= 7 && /^[\d\s().+-]+$/.test(value)) return 'phone';

    return 'name';
  }

  private buildSearchClause(
    term: string,
    kind: SearchKind,
  ): WhereOptions | null {
    const value = term.trim();

    switch (kind) {
      case 'none':
        return null;

      case 'application_id':
        return { application_id: value.toUpperCase() };

      case 'email':
        // CITEXT column, so equality is already case-insensitive; the ILIKE
        // arm covers the "or partial" half of the brief.
        return {
          [Op.or]: [{ email: value }, { email: { [Op.iLike]: `%${value}%` } }],
        } as WhereOptions;

      case 'ssn_last4':
        return { ssn_last4: value };

      case 'phone': {
        /*
         * "Strip all non-digits from input, match against phone_normalized."
         * A full 10-digit number is an equality hit on the B-tree index; a
         * shorter partial (the brief calls out last-7) becomes a suffix match.
         */
        const digits = value.replace(/\D/g, '');
        const local = digits.length > 10 ? digits.slice(-10) : digits;

        return local.length === 10
          ? { phone_normalized: local }
          : { phone_normalized: { [Op.like]: `%${local}` } };
      }

      case 'name':
        return this.buildNameClause(value);
    }
  }

  /**
   * §8.2 name handling: first only, last only, and "John Smith" / "Smith John"
   * / "Smith, John" all match.
   *
   * Tokens are matched against both name columns in either order, prefix-first
   * (`ILIKE 'john%'`) exactly as the brief specifies. pg_trgm's GIN indexes
   * make the two-sided fallback affordable.
   */
  private buildNameClause(value: string): WhereOptions {
    const tokens = value
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, 3);

    if (tokens.length === 0) return {};

    if (tokens.length === 1) {
      const [token] = tokens;

      return {
        [Op.or]: [
          { first_name: { [Op.iLike]: `${token}%` } },
          { last_name: { [Op.iLike]: `${token}%` } },
          // Substring fallback for middle-of-name matches ("nders" -> Anderson).
          { first_name: { [Op.iLike]: `%${token}%` } },
          { last_name: { [Op.iLike]: `%${token}%` } },
        ],
      } as WhereOptions;
    }

    const [first, second] = tokens;

    return {
      [Op.or]: [
        {
          [Op.and]: [
            { first_name: { [Op.iLike]: `${first}%` } },
            { last_name: { [Op.iLike]: `${second}%` } },
          ],
        },
        // "Smith John" and "Smith, John" — same tokens, reversed columns.
        {
          [Op.and]: [
            { first_name: { [Op.iLike]: `${second}%` } },
            { last_name: { [Op.iLike]: `${first}%` } },
          ],
        },
      ],
    } as WhereOptions;
  }

  /** §8.2 filter bar. */
  private buildFilterClauses(filters: SearchApplicationsDto): WhereOptions[] {
    const clauses: WhereOptions[] = [];

    if (filters.status?.length) {
      clauses.push({ status: { [Op.in]: filters.status } } as WhereOptions);
    }

    if (filters.state?.length) {
      clauses.push({
        state: { [Op.in]: filters.state.map((code) => code.toUpperCase()) },
      } as WhereOptions);
    }

    if (filters.loan_purpose?.length) {
      clauses.push({
        loan_purpose: { [Op.in]: filters.loan_purpose },
      } as WhereOptions);
    }

    if (filters.assigned_agent_id) {
      clauses.push(
        filters.assigned_agent_id === 'unassigned'
          ? ({ assigned_agent_id: { [Op.is]: null } } as WhereOptions)
          : ({ assigned_agent_id: filters.assigned_agent_id } as WhereOptions),
      );
    }

    if (filters.called_in !== undefined) {
      clauses.push({ called_in: filters.called_in } as WhereOptions);
    }

    if (filters.bank_verified !== undefined) {
      clauses.push({ bank_verified: filters.bank_verified } as WhereOptions);
    }

    if (filters.possible_duplicate !== undefined) {
      clauses.push({
        possible_duplicate: filters.possible_duplicate,
      } as WhereOptions);
    }

    if (filters.utm_source) {
      clauses.push(
        filters.utm_source === 'direct'
          ? ({
              [Op.or]: [{ utm_source: { [Op.is]: null } }, { utm_source: '' }],
            } as WhereOptions)
          : ({ utm_source: filters.utm_source } as WhereOptions),
      );
    }

    const band = filters.amount_band
      ? AMOUNT_BANDS[filters.amount_band]
      : undefined;

    if (band) {
      const [min, max] = band;

      clauses.push({
        amount_requested:
          max === null ? { [Op.gte]: min } : { [Op.gte]: min, [Op.lt]: max },
      } as WhereOptions);
    }

    const range = this.buildDateRange(filters);
    if (range) clauses.push(range);

    return clauses;
  }

  /**
   * Date filters are resolved against the lender's own calendar, so a file
   * submitted at 11pm Pacific belongs to that Pacific day rather than to the
   * next UTC one.
   */
  private buildDateRange(filters: SearchApplicationsDto): WhereOptions | null {
    const { date_from, date_to, date } = filters;

    if (date) {
      return {
        created_at: {
          [Op.between]: [
            fromZonedTime(`${date}T00:00:00.000`, ADMIN_TIMEZONE),
            fromZonedTime(`${date}T23:59:59.999`, ADMIN_TIMEZONE),
          ],
        },
      } as WhereOptions;
    }

    if (!date_from && !date_to) return null;

    const bounds: Record<symbol, Date> = {};

    if (date_from) {
      bounds[Op.gte] = fromZonedTime(
        `${date_from}T00:00:00.000`,
        ADMIN_TIMEZONE,
      );
    }

    if (date_to) {
      bounds[Op.lte] = fromZonedTime(`${date_to}T23:59:59.999`, ADMIN_TIMEZONE);
    }

    return { created_at: bounds } as WhereOptions;
  }

  /** Distinct values for the filter dropdowns. */
  async filterOptions(): Promise<{
    states: string[];
    utm_sources: string[];
    loan_purposes: string[];
  }> {
    const [states, sources, purposes] = await Promise.all([
      this.distinct('state'),
      this.distinct('utm_source'),
      this.distinct('loan_purpose'),
    ]);

    return {
      states,
      // A blank utm_source is "direct" everywhere else in the portal.
      utm_sources: sources.map((value) => value || 'direct'),
      loan_purposes: purposes,
    };
  }

  private async distinct(column: string): Promise<string[]> {
    const rows = (await this.applicationModel.findAll({
      attributes: [[literal(`DISTINCT "${column}"`), 'value']],
      order: [[literal(`"${column}"`), 'ASC']],
      raw: true,
    })) as unknown as Array<{ value: string | null }>;

    return rows
      .map((row) => row.value)
      .filter((value): value is string => Boolean(value));
  }

  static toRow(application: Application): SearchResultRow {
    const agent = (application as unknown as { assigned_agent?: AdminUser })
      .assigned_agent;

    return {
      id: application.id,
      application_id: application.application_id,
      status: application.status,
      status_label: humanizeStatus(application.status),
      full_name: `${application.first_name} ${application.last_name}`.trim(),
      first_name: application.first_name,
      last_name: application.last_name,
      email: application.email,
      phone: formatPhone(application.phone),
      state: application.state,
      amount_requested: Number(application.amount_requested),
      loan_purpose: application.loan_purpose,
      ssn_masked: maskSsn(application.ssn_last4),
      account_masked: maskAccount(application.account_last4),
      called_in: Boolean(application.called_in),
      bank_verified: Boolean(application.bank_verified),
      possible_duplicate: Boolean(application.possible_duplicate),
      assigned_agent: agent ? { id: agent.id, email: agent.email } : null,
      utm_source: application.utm_source ?? null,
      created_at: application.created_at ?? null,
      updated_at: application.updated_at ?? null,
    };
  }
}
