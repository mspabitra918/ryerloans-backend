import { ApplicationWorkflowService } from './application-workflow.service';

describe('ApplicationWorkflowService resendEmail', () => {
  it('mints a fresh bank verification token before resending a drip email', async () => {
    const application = {
      id: 'app-uuid-123',
      application_id: 'YVZPH3',
      first_name: 'John',
      email: 'john@example.com',
      amount_requested: 5000,
    };

    const original = {
      application_id: application.id,
      template_key: 'bank_verification_1',
    };

    const tokenService = {
      issue: jest.fn().mockResolvedValue({
        url: 'http://localhost:3000/bank-verification/token-123',
      }),
    };

    const dripEmailService = {
      sendDripEmail: jest.fn().mockResolvedValue(true),
    };

    const emailLogService = {
      findById: jest.fn().mockResolvedValue(original),
    };

    const auditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const workflow = new ApplicationWorkflowService(
      {} as any,
      {} as any,
      {} as any,
      emailLogService as any,
      {} as any,
      {} as any,
      dripEmailService as any,
      auditLogService as any,
      {} as any,
      tokenService as any,
      {} as any,
    );

    workflow.findOrFail = jest.fn().mockResolvedValue(application);

    const result = await workflow.resendEmail({
      applicationId: 'any-app-id',
      emailLogId: 'log-123',
      options: {
        admin: {
          adminUserId: 'admin-1',
          actorType: 'admin',
          ipAddress: '127.0.0.1',
        },
        note: 'test',
      } as any,
    });

    expect(tokenService.issue).toHaveBeenCalledWith(
      application.id,
      'bank_verification',
    );
    expect(dripEmailService.sendDripEmail).toHaveBeenCalledWith(
      'bank_verification_1',
      expect.objectContaining({
        actionUrl: 'http://localhost:3000/bank-verification/token-123',
      }),
    );
    expect(result).toEqual({
      resent: true,
      template_key: 'bank_verification_1',
    });
  });
});
