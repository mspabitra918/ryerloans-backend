import { frontendUrl, verifyBankUrl } from './brand.constants';

describe('brand.constants', () => {
  const originalBorrowerBaseUrl = process.env.BORROWER_BASE_URL;
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(() => {
    delete process.env.BORROWER_BASE_URL;
    delete process.env.FRONTEND_URL;
  });

  afterAll(() => {
    if (originalBorrowerBaseUrl === undefined) {
      delete process.env.BORROWER_BASE_URL;
    } else {
      process.env.BORROWER_BASE_URL = originalBorrowerBaseUrl;
    }

    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it('prefers BORROWER_BASE_URL when building borrower-facing URLs', () => {
    process.env.BORROWER_BASE_URL = 'https://app.example.com';
    process.env.FRONTEND_URL = 'https://fallback.example.com';

    expect(frontendUrl()).toBe('https://app.example.com');
    expect(verifyBankUrl()).toBe('https://app.example.com/bank-verification');
  });

  it('falls back to the public frontend URL when BORROWER_BASE_URL is unset', () => {
    process.env.FRONTEND_URL = 'https://public.example.com';

    expect(frontendUrl()).toBe('https://public.example.com');
    expect(verifyBankUrl()).toBe('https://public.example.com/bank-verification');
  });
});
