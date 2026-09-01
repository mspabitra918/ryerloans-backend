import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { StateAvailability } from './models/state-availability.model';

@Injectable()
export class StateAvailabilityService {
  constructor(
    @InjectModel(StateAvailability)
    private readonly stateModel: typeof StateAvailability,
  ) {}

  async validateStateEligibility(
    stateCode: string,
    requestedAmount: number,
  ): Promise<{ eligible: boolean; waitlist: boolean; reason?: string }> {
    const state = await this.stateModel.findByPk(stateCode.toUpperCase());

    if (!state || !state.is_active) {
      return {
        eligible: false,
        waitlist: false,
        reason: `Lending is currently not available in ${stateCode.toUpperCase()}.`,
      };
    }

    if (state.waitlist_only) {
      return {
        eligible: false,
        waitlist: true,
        reason: `Applications in ${stateCode.toUpperCase()} are waitlist-only.`,
      };
    }

    if (requestedAmount > state.max_loan_amount) {
      return {
        eligible: false,
        waitlist: false,
        reason: `Requested amount exceeds max state cap of $${state.max_loan_amount}.`,
      };
    }

    return { eligible: true, waitlist: false };
  }

  /** States the application form may offer. */
  async listActive(): Promise<
    Array<{
      state_code: string;
      max_loan_amount: number;
      waitlist_only: boolean;
    }>
  > {
    const states = await this.stateModel.findAll({
      where: { is_active: true },
      order: [['state_code', 'ASC']],
    });

    return states.map((state) => ({
      state_code: state.state_code,
      max_loan_amount: Number(state.max_loan_amount),
      waitlist_only: Boolean(state.waitlist_only),
    }));
  }

  async upsertStateRule(
    data: Partial<StateAvailability>,
  ): Promise<StateAvailability> {
    const [record] = await this.stateModel.upsert(data as any);
    return record;
  }
}
