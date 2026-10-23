// Provider selection (PLANNING.md: services/email). `email` is a plain object so tests can swap
// in a fake provider; the test suite never sends real email.
import { config } from '../../config/index.js';
import { createResendProvider } from './resendProvider.js';
import { createSmtpProvider } from './smtpProvider.js';

let cached;

/** null when ready, otherwise what's missing. */
function configurationProblem() {
  const { provider, from, resendApiKey } = config.email;
  if (!provider) return 'EMAIL_PROVIDER is not set';
  if (!from) return 'EMAIL_FROM is not set';
  if (provider === 'resend' && !resendApiKey) return 'RESEND_API_KEY is not set';
  return null;
}

function getProvider() {
  const problem = configurationProblem();
  if (problem) throw new Error(problem);
  cached ??= config.email.provider === 'resend'
    ? createResendProvider({ apiKey: config.email.resendApiKey })
    : createSmtpProvider(config.email.smtp);
  return cached;
}

export const email = {
  configurationProblem,
  isConfigured: () => configurationProblem() === null,
  getProvider,
  from: () => config.email.from,
};
