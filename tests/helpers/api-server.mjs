import http from 'node:http'
// Local fixture API for manual UI checks; values are synthetic.
const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Key')
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
  response.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, Location, Content-Disposition')
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('X-Request-ID', 'reqmas-demo-42')
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
  const chunks = []; try { for await (const chunk of request) chunks.push(chunk) } catch { return }
  const bodyBytes = Buffer.concat(chunks), body = bodyBytes.toString('utf8')
  const url = new URL(request.url, 'http://127.0.0.1:58808')
  if (url.pathname === '/slow') await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(10000, Number(url.searchParams.get('delayMs') ?? 1500) || 0))))
  if (response.destroyed) return
  if (url.pathname === '/numbers') { response.end(`{"id":${url.searchParams.get('next') === '1' ? '9007199254740992' : '9007199254740993'},"note":"exact integer"}`); return }
  if (url.pathname === '/wide-json') { response.end(JSON.stringify(Object.fromEntries(Array.from({ length: 1010 }, (_, i) => [`field${i}`, i])))); return }
  if (url.pathname === '/empty') { response.writeHead(204); response.end(); return }
  if (url.pathname === '/error') { response.writeHead(422); response.end(JSON.stringify({ error: 'Synthetic validation error' })); return }
  if (url.pathname === '/download') { response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Content-Disposition', 'attachment; filename="reqmas-test.bin"'); response.end(Buffer.from([0, 255, 13, 10, 128, 37, 80, 68, 70])); return }
  if (url.pathname === '/image') { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4RQAAAAASUVORK5CYII=', 'base64')); return }
  if (url.pathname === '/items') { const itemId = Number(url.searchParams.get('caseId') ?? 1); response.end(JSON.stringify({ id: itemId, name: itemId === 2 ? 'Second item' : 'First item', enabled: true })); return }
  if (url.pathname === '/bad-item') { response.end(JSON.stringify({ id: 'wrong type', name: null })); return }
  if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/echo' }); response.end(); return }
  if (url.pathname === '/token') { response.end(JSON.stringify({ access_token: 'demo-token', token_type: 'bearer', expires_in: 3600, user: { id: 42, name: 'Alex' } })); return }
  if (url.pathname === '/me') { const authenticated = request.headers.authorization === 'Bearer demo-token'; response.writeHead(authenticated ? 200 : 401); response.end(JSON.stringify({ authenticated, user: { id: 42, name: 'Alex' } })); return }
  response.end(JSON.stringify({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), queryEntries: [...url.searchParams], headers: request.headers, body, bodyBytes: bodyBytes.length, bodyBase64: bodyBytes.toString('base64') }))
})
server.listen(58808, '127.0.0.1', () => process.stdout.write('Reqmas fixture API: http://127.0.0.1:58808\n'))
