const terminalCodes = new Set([
  'AUTH_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'ACCOUNT_DISABLED', 'ROLE_NOT_SUPPORTED',
])

export class ApiError extends Error {
  constructor(code, { status = 0, fieldErrors = {}, kind = 'http' } = {}) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.fieldErrors = fieldErrors
    this.kind = kind
  }
}

export function isSessionFailure(error) {
  return terminalCodes.has(error.code) && [401, 403].includes(error.status)
}

export function createHttpClient({ baseUrl, fetchImpl = globalThis.fetch, onAuthFailure = () => {} }) {
  return {
    async request(path, { method = 'GET', body, signal, notifyAuthFailure = true } = {}) {
      let response
      try {
        response = await fetchImpl(baseUrl + path, {
          method, credentials: 'include', signal,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error
        throw new ApiError('NETWORK_ERROR', { kind: 'network' })
      }
      let envelope
      try {
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error()
        envelope = await response.json()
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error
        throw new ApiError('UNEXPECTED_RESPONSE', { status: response.status, kind: 'protocol' })
      }
      if (response.ok && envelope?.ok === true && envelope.data && typeof envelope.data === 'object') {
        return { data: envelope.data, status: response.status }
      }
      const failure = envelope?.error
      if (!response.ok && envelope?.ok === false && typeof failure?.code === 'string' &&
        failure.fieldErrors && typeof failure.fieldErrors === 'object' && !Array.isArray(failure.fieldErrors)) {
        const error = new ApiError(failure.code, {
          status: response.status, fieldErrors: failure.fieldErrors,
        })
        if (notifyAuthFailure && isSessionFailure(error)) onAuthFailure(error)
        throw error
      }
      throw new ApiError('UNEXPECTED_RESPONSE', { status: response.status, kind: 'protocol' })
    },
  }
}
