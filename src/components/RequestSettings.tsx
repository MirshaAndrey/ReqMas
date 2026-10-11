import { useState } from 'react'
import type { ConnectionSettings, Request } from '../types/request'
import '../connection.css'
export function RequestSettings({ request, update, disabled, desktop }: { request: Request; update: (change: Partial<Request>) => void; disabled: boolean; desktop: boolean }) {
  const [visibleKeyRequest, setVisibleKeyRequest] = useState('')
  const showPrivateKey = visibleKeyRequest === request.id
  const connection = request.connection ?? {}
  const changeConnection = (key: keyof ConnectionSettings, value: string) => {
    const next = { ...connection, [key]: value }
    if (!value) delete next[key]
    update({ connection: Object.keys(next).length ? next : undefined })
  }
  return <div className="request-settings">
    <label>Timeout (seconds)<input disabled={disabled} aria-label="Request timeout seconds" type="number" min={0.1} max={300} step={0.1} value={(request.timeoutMs ?? 30000) / 1000} onChange={e => update({ timeoutMs: Math.round(Math.max(100, Math.min(300000, Number(e.target.value) * 1000 || 100))) })} /></label>
    <label className="check-label"><input disabled={disabled} aria-label="Follow redirects" type="checkbox" checked={request.followRedirects !== false} onChange={e => update({ followRedirects: e.target.checked })} /> Follow redirects</label>
    <p className="config-hint">Used for manual requests and the collection runner. {desktop ? 'Turn redirects off to inspect the first 3xx response.' : 'Inspecting redirects without following them requires Desktop mode.'}</p>
    <fieldset className="connection-settings" disabled={disabled || !desktop}>
      <legend>Proxy &amp; TLS <span>Desktop</span></legend>
      <p className="config-hint">{desktop ? 'HTTP and HTTPS proxies. Custom trusted CA certificates extend the default trust store; certificate verification remains enabled. Variables such as {{proxyUrl}} are supported.' : 'These connection options require the desktop application. Requests with saved connection options cannot be sent from browser mode.'}</p>
      <div className="connection-proxy">
        <label>Proxy URL<input aria-label="Proxy URL" placeholder="http://localhost:8080" value={connection.proxyUrl ?? ''} onChange={e => changeConnection('proxyUrl', e.target.value)} autoComplete="off" /></label>
        <label>Proxy username<input aria-label="Proxy username" value={connection.proxyUsername ?? ''} onChange={e => changeConnection('proxyUsername', e.target.value)} autoComplete="off" /></label>
        <label>Proxy password<input aria-label="Proxy password" type="password" value={connection.proxyPassword ?? ''} onChange={e => changeConnection('proxyPassword', e.target.value)} autoComplete="new-password" /></label>
      </div>
      <label>Trusted CA bundle (PEM)<textarea aria-label="Trusted CA bundle PEM" placeholder="-----BEGIN CERTIFICATE-----" value={connection.caPem ?? ''} onChange={e => changeConnection('caPem', e.target.value)} spellCheck={false} /></label>
      <div className="connection-identity">
        <label>Client certificate chain (PEM)<textarea aria-label="Client certificate PEM" placeholder="-----BEGIN CERTIFICATE-----" value={connection.clientCertPem ?? ''} onChange={e => changeConnection('clientCertPem', e.target.value)} spellCheck={false} /></label>
        <label>Client private key (PEM)<textarea aria-label="Client private key PEM" className={showPrivateKey ? '' : 'secret-pem'} placeholder="Unencrypted PKCS#8 or RSA private key" value={connection.clientKeyPem ?? ''} onChange={e => changeConnection('clientKeyPem', e.target.value)} spellCheck={false} /></label>
      </div>
      <label className="check-label"><input type="checkbox" aria-label="Show client private key" checked={showPrivateKey} onChange={e => setVisibleKeyRequest(e.target.checked ? request.id : '')} /> Show private key</label>
      <p className="config-hint">Proxy passwords and client private keys are encrypted in desktop storage and automatic backups with Windows DPAPI or a key in macOS Keychain / Linux Secret Service. Exported backups may include them.</p>
    </fieldset>
    {!!Object.keys(connection).length && <button type="button" className="connection-clear" disabled={disabled} onClick={() => update({ connection: undefined })}>Clear connection settings</button>}
  </div>
}
