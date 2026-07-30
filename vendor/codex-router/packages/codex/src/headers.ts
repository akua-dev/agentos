const requestHeadersToRemove = [
  "authorization",
  "api-key",
  "baggage",
  "chatgpt-account-id",
  "host",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "x-api-key",
  "x-ai-gateway-token",
  "x-ai-router-token",
  "x-codex-router-session",
  "x-ai-gateway-session",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]

const responseHeadersToRemove = [
  "connection",
  "content-encoding",
  "content-length",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]

export const sanitizeRequestHeaders = (input: Headers): Headers => {
  const headers = new Headers(input)
  for (const name of requestHeadersToRemove) {
    headers.delete(name)
  }
  return headers
}

export const sanitizeResponseHeaders = (input: Headers): Headers => {
  const headers = new Headers(input)
  for (const name of responseHeadersToRemove) {
    headers.delete(name)
  }
  return headers
}
