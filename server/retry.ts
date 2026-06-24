import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'

const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])

function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true // fetch() network failure
  const name = (err as { name?: unknown } | null)?.name
  if (typeof name === 'string' && /Connection|Timeout/i.test(name)) return true
  const code = (err as { code?: unknown } | null)?.code ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code)
}

// Transient = worth retrying: HTTP 429 / 5xx, or a network/connection failure. Everything else
// (4xx config errors, parse/unknown errors) is permanent and surfaces immediately.
export function isTransientError(err: unknown): boolean {
  const status = errorStatus(err)
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599)
  return isNetworkError(err)
}

export type RetryOpts = {
  getEmitted: () => boolean
  signal: AbortSignal
  maxRetries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

// Re-run provider.send up to maxRetries times, but ONLY for a transient error that occurred before
// any output streamed (getEmitted() === false) and while the turn is not aborted. Backoff is
// exponential (1s, 2s, 4s). Retrying after partial output would duplicate text, so it is excluded.
export async function sendWithRetry(
  provider: Provider,
  params: TurnParams,
  ctx: ProviderContext,
  opts: RetryOpts,
): Promise<TurnResult> {
  const maxRetries = opts.maxRetries ?? 3
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.send(params, ctx)
    } catch (err) {
      const canRetry = attempt < maxRetries && !opts.getEmitted() && !opts.signal.aborted && isTransientError(err)
      if (!canRetry) throw err
      await sleep(1000 * 2 ** attempt, opts.signal)
      if (opts.signal.aborted) throw err
    }
  }
}
