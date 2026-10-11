export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
import type { RunnerScenario } from '../services/runnerScenarios'
export type Pair = { id: string; key: string; value: string; enabled: boolean; secret?: boolean }
export type FileBody = { name: string; type: string; base64: string }
export type Assertion = { id: string; kind: 'status' | 'duration' | 'contains' | 'header' | 'json'; key: string; expected: string; enabled: boolean }
export type AssertionResult = { name: string; passed: boolean; actual: string }
export type OAuth = { tokenUrl: string; clientId: string; clientSecret: string; scope: string; accessToken: string; expiresAt?: number; clientAuth?: 'body' | 'basic'; flow?: 'client_credentials' | 'authorization_code'; authorizationUrl?: string; redirectUri?: string; refreshToken?: string; autoRefresh?: boolean }
export type ConnectionSettings = { proxyUrl?: string; proxyUsername?: string; proxyPassword?: string; caPem?: string; clientCertPem?: string; clientKeyPem?: string }
export type AuthMode = 'inherit' | 'none' | 'basic' | 'bearer' | 'oauth' | 'apikey'
export type AuthSettings = { authMode?: AuthMode; basicAuth?: { username: string; password: string }; bearerToken?: string; oauth?: OAuth; apiKey?: { key: string; value: string; in: 'header' | 'query' } }
export type Extraction = { id: string; source: 'json' | 'header'; path: string; variable: string; enabled: boolean }
export type Request = AuthSettings & { id: string; collectionId: string; folder?: string; browserCookies?: boolean; name: string; method: Method; url: string; params: Pair[]; headers: Pair[]; bodyType: 'none' | 'json' | 'text' | 'xml' | 'urlencoded' | 'formdata' | 'binary'; body: string; form?: Pair[]; files?: (FileBody & { id: string; key: string; enabled: boolean })[]; binary?: FileBody; variables?: Pair[]; tests?: Assertion[]; extractions?: Extraction[]; responseSchema?: string; timeoutMs?: number; followRedirects?: boolean; connection?: ConnectionSettings }
export type Collection = AuthSettings & { id: string; name: string; variables?: Pair[]; folders?: string[] }
export type Environment = { id: string; name: string; variables: Pair[] }
export type Cookie = { id: string; name: string; value: string; domain: string; path: string; secure: boolean; hostOnly: boolean; expiresAt?: number }
export type Redirect = { from: string; to: string; status: number }
export type Response = { status: number; statusText: string; duration: number; size: number; headers: Record<string, string>; body: string; bodyBase64?: string; binary?: boolean; bodyTruncated?: boolean; headersDuration?: number; downloadDuration?: number; redirects?: Redirect[]; setCookies?: string[]; url?: string; captures?: AssertionResult[] }
export type PreparedRequestSnapshot = { method: string; url: string; headers: Record<string, string>; body?: string; binarySize?: number; bodyTruncated?: boolean }
export type RequestJournalEntry = { id: string; name: string; startedAt: string; transport: 'desktop' | 'browser'; state: 'sending' | 'complete' | 'failed'; request?: PreparedRequestSnapshot; duration?: number; status?: number; statusText?: string; finalUrl?: string; headersDuration?: number; downloadDuration?: number; responseHeaders?: Record<string, string>; redirects?: Redirect[]; error?: string }
export type History = { id: string; request: Request; time: string; status: number; duration: number; response?: Response; bodyTruncated?: boolean }
export type WorkspaceData = { collections: Collection[]; requests: Request[]; environments: Environment[]; environmentId: string; cookies: Cookie[]; history: History[]; trash: { requests: Request[]; collections: Collection[] }; runnerScenarios?: RunnerScenario[] }

