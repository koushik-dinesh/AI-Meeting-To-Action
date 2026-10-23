// The only module that talks to the Anthropic API. The API key stays in backend config.
//
// `claude` is a plain object so tests can replace its methods with fakes; the normal
// test suite never calls the real API.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { PermanentJobError } from '../../jobs/queue.js';
import { OUTPUT_FORMAT } from './schema.js';

let client;
function getClient() {
  if (!config.ai.apiKey) throw new PermanentJobError('ANTHROPIC_API_KEY is not configured', { publicMessage: 'AI extraction is not configured' });
  client ??= new Anthropic({ apiKey: config.ai.apiKey, timeout: config.ai.timeoutMs, maxRetries: 2 });
  return client;
}

/** Error for a failed provider call. `retryable` tells the job queue whether to try again. */
export class AiProviderError extends Error {
  constructor(message, { retryable, status, publicMessage, cause } = {}) {
    super(message, { cause });
    this.name = 'AiProviderError';
    this.retryable = retryable;
    this.status = status;
    this.publicMessage = publicMessage ?? message;
  }
}

/** Maps SDK errors to retryable / permanent. Messages never include the API key. */
export function classifyError(err) {
  if (err instanceof AiProviderError || err instanceof PermanentJobError) return err;
  const status = err?.status;
  const detail = `${err?.constructor?.name ?? 'Error'}${status ? ` ${status}` : ''}: ${err?.message ?? err}`;

  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError(detail, { retryable: false, status, publicMessage: 'The AI provider rejected the API key', cause: err });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AiProviderError(detail, { retryable: false, status, publicMessage: `AI model "${config.ai.model}" was not found`, cause: err });
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    // Includes 429, 5xx/529 overloaded, timeouts and network errors (APIConnectionTimeoutError extends APIConnectionError).
    return new AiProviderError(detail, { retryable: true, status, publicMessage: 'The AI provider is temporarily unavailable', cause: err });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return new AiProviderError(detail, { retryable: false, status, publicMessage: 'The AI provider rejected the request', cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = status === 408 || status === 409 || (status ?? 0) >= 500;
    return new AiProviderError(detail, { retryable, status, publicMessage: 'The AI provider returned an error', cause: err });
  }
  // Unknown (e.g. a bug): retry a limited number of times via the queue.
  return new AiProviderError(detail, { retryable: true, publicMessage: 'AI extraction failed unexpectedly', cause: err });
}

/**
 * Sends one extraction request. Streams (long transcripts / outputs) and returns the final
 * message's JSON text plus metadata. Throws AiProviderError.
 * @returns {{ text: string, stopReason: string, model: string, usage: { inputTokens, outputTokens } }}
 */
async function extract({ system, user }) {
  const anthropic = getClient();
  const params = {
    model: config.ai.model,
    max_tokens: config.ai.maxOutputTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { effort: config.ai.effort, format: OUTPUT_FORMAT },
  };

  let message;
  try {
    // Refusal fallback (beta): if the model declines, the API retries on a fallback model.
    message = config.ai.refusalFallback
      ? await anthropic.beta.messages
          .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          .finalMessage()
      : await anthropic.messages.stream(params).finalMessage();
  } catch (err) {
    throw classifyError(err);
  }

  if (message.stop_reason === 'refusal') {
    throw new AiProviderError(`Model refused (category: ${message.stop_details?.category ?? 'unknown'})`, {
      retryable: false,
      publicMessage: 'The AI model declined to process this transcript',
    });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AiProviderError('Response truncated at max_tokens', {
      retryable: false,
      publicMessage: 'The AI response was too long; raise ANTHROPIC_MAX_OUTPUT_TOKENS',
    });
  }

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    stopReason: message.stop_reason,
    model: message.model ?? config.ai.model,
    usage: { inputTokens: message.usage?.input_tokens ?? null, outputTokens: message.usage?.output_tokens ?? null },
  };
}

/** Confirms the configured model id exists for this API key (Models API). */
async function verifyModel() {
  try {
    return await getClient().models.retrieve(config.ai.model);
  } catch (err) {
    throw classifyError(err);
  }
}

export const claude = {
  isConfigured: () => Boolean(config.ai.apiKey),
  model: () => config.ai.model,
  extract,
  verifyModel,
};
