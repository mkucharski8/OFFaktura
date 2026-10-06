const crypto = require('crypto')
const express = require('express')
const fs = require('fs')
const path = require('path')

const app = express()
const port = Number(process.env.PORT) || 3000
const index = path.join(__dirname, 'public', 'index.html')

const cfg = {
  merchantId: Number(process.env.P24_MERCHANT_ID),
  posId: Number(process.env.P24_POS_ID || process.env.P24_MERCHANT_ID),
  crc: process.env.P24_CRC || '',
  apiKey: process.env.P24_API_KEY || '',
  sandbox: process.env.P24_SANDBOX !== '0',
  publicUrl: (process.env.PUBLIC_URL || 'https://offaktura.marcinkucharski.pl').replace(/\/$/, ''),
  price: Number(process.env.PRICE_GROSZE) || 4900,
  privateKey: (process.env.LICENSE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  resendKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'OFFaktura <onboarding@resend.dev>',
  notify: process.env.ORDER_NOTIFY_EMAIL || '',
  statsToken: process.env.STATS_TOKEN || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data')
}
const p24Host = process.env.P24_HOST || (cfg.sandbox ? 'https://sandbox.przelewy24.pl' : 'https://secure.przelewy24.pl')
const salesOpen = () => Boolean(cfg.merchantId && cfg.posId && cfg.crc && cfg.apiKey && cfg.privateKey) &&
  (!cfg.sandbox || process.env.SANDBOX_SALES === '1')

const ordersDir = path.join(cfg.dataDir, 'orders')
fs.mkdirSync(ordersDir, { recursive: true })
const orderFile = id => path.join(ordersDir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
const readOrder = id => {
  try { return JSON.parse(fs.readFileSync(orderFile(id), 'utf8')) } catch { return null }
}
const writeOrder = order => fs.writeFileSync(orderFile(order.id), JSON.stringify(order, null, 2))

function purgeUnpaid() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const file of fs.readdirSync(ordersDir)) {
    const order = readOrder(file.replace(/\.json$/, ''))
    if (order && order.status !== 'paid' && Date.parse(order.createdAt) < cutoff) fs.unlinkSync(orderFile(order.id))
  }
}
purgeUnpaid()
setInterval(purgeUnpaid, 24 * 60 * 60 * 1000).unref()

const statsDir = path.join(cfg.dataDir, 'stats')
fs.mkdirSync(statsDir, { recursive: true })
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|httpclient|headless|lighthouse|monitor/i
const METRICS = ['views', 'entries', 'downloads', 'checkouts', 'paid']
const statsCache = new Map()
const dirtyDays = new Set()
const warsawDay = (date = new Date()) => date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })
const statsFile = day => path.join(statsDir, `${day}.json`)

function dayStats(day) {
  if (!statsCache.has(day)) {
    let data = null
    try { data = JSON.parse(fs.readFileSync(statsFile(day), 'utf8')) } catch { /* nowy dzień */ }
    statsCache.set(day, data || { pages: {}, channels: {}, devices: {} })
  }
  return statsCache.get(day)
}

function flushStats() {
  for (const day of dirtyDays) fs.writeFileSync(statsFile(day), JSON.stringify(dayStats(day)))
  dirtyDays.clear()
}
setInterval(flushStats, 15 * 1000).unref()

const clean = (value, max = 60) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max)

function channelOf(utm, ref) {
  const source = clean(utm?.source)
  if (source) return [source, clean(utm?.campaign), clean(utm?.content)].filter(Boolean).join(' · ')
  const host = clean(String(ref || '').replace(/^www\./, ''), 80)
  return host || 'bezpośrednio'
}

function record(metric, { channel, page, device } = {}) {
  const day = warsawDay()
  const stats = dayStats(day)
  stats[metric] = (stats[metric] || 0) + 1
  const bump = (group, key) => {
    if (!key) return
    const row = stats[group][key] || (stats[group][key] = {})
    row[metric] = (row[metric] || 0) + 1
  }
  bump('channels', channel)
  bump('pages', page)
  bump('devices', device)
  dirtyDays.add(day)
}

const sign = fields => crypto.createHash('sha384').update(JSON.stringify(fields)).digest('hex')

async function p24(method, route, body) {
  const res = await fetch(`${p24Host}/api/v1${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${cfg.posId}:${cfg.apiKey}`).toString('base64')
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* treść nie-JSON */ }
  if (!res.ok) throw new Error(`P24 ${res.status}: ${data?.error || text}`)
  return data
}

function issueLicense(order) {
  const payload = Buffer.from(JSON.stringify({
    id: order.id.slice(0, 12),
    email: order.email,
    company: order.company,
    nip: order.nip,
    issued: new Date().toISOString().slice(0, 10)
  }), 'utf8')
  const signature = crypto.sign(null, payload, cfg.privateKey)
  return `OFF-${payload.toString('base64url')}.${signature.toString('base64url')}`
}

async function sendMail(to, subject, text) {
  if (!cfg.resendKey || !to) return
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.resendKey}` },
    body: JSON.stringify({ from: cfg.mailFrom, to: [to], subject, text })
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
}

function customerMail(order) {
  return [
    'Dziękujemy za zakup OFFaktury.',
    '',
    'Twój klucz licencji:',
    '',
    order.license,
    '',
    'Jak aktywować: otwórz OFFakturę, wejdź w Ustawienia, wklej klucz w karcie Licencja i kliknij Aktywuj.',
    'Potem możesz przełączyć KSeF na środowisko produkcyjne.',
    '',
    'Fakturę za zakup wyślemy na ten adres osobno.',
    '',
    'OFFaktura · Faktury lokalnie',
    cfg.publicUrl
  ].join('\n')
}

function ownerMail(order) {
  return [
    'Nowa sprzedaż OFFaktury. Wystaw fakturę:',
    '',
    `Firma / imię i nazwisko: ${order.company}`,
    `NIP: ${order.nip || 'brak (konsument)'}`,
    `Adres: ${order.address}`,
    `E-mail: ${order.email}`,
    `Kwota: ${(order.amount / 100).toFixed(2)} zł (zw. z VAT)`,
    `Zamówienie: ${order.id}`,
    `P24 orderId: ${order.p24OrderId}`,
    `Opłacone: ${order.paidAt}`
  ].join('\n')
}

const hits = new Map()
function limited(ip) {
  const now = Date.now()
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000)
  list.push(now)
  hits.set(ip, list)
  return list.length > 10
}

app.set('trust proxy', 1)
app.use((req, res, next) => {
  if (req.hostname.endsWith('.up.railway.app') && !req.path.startsWith('/api/') && req.path !== '/health') {
    return res.redirect(301, cfg.publicUrl + req.originalUrl)
  }
  next()
})
app.use(express.json({ limit: '20kb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'offaktura' })
})

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ salesOpen: salesOpen(), price: cfg.price })
})

const PAGES = new Set(['/', '/regulamin', '/prywatnosc', '/dziekujemy', '/landing'])

app.post('/api/hit', (req, res) => {
  res.status(204).end()
  const ua = String(req.get('user-agent') || '')
  if (!ua || BOT.test(ua)) return
  const body = req.body || {}
  const page = PAGES.has(body.path) ? body.path : 'inne'
  const ref = String(body.ref || '').toLowerCase()
  const internal = ref === req.hostname
  const channel = internal ? 'z innej podstrony' : channelOf(body.utm, ref)
  const device = /Mobi|Android|iPhone|iPad/i.test(ua) ? 'telefon' : 'komputer'
  if (body.kind === 'view') {
    record('views', { page, device })
    if (!internal) record('entries', { channel, device })
  } else if (body.kind === 'download') {
    record('downloads', { channel, page, device })
  }
})

app.post('/api/checkout', async (req, res) => {
  if (!salesOpen()) return res.status(503).json({ error: 'Sprzedaż jeszcze nie ruszyła.' })
  if (limited(req.ip)) return res.status(429).json({ error: 'Za dużo prób. Spróbuj za kilka minut.' })
  const email = String(req.body?.email || '').trim().slice(0, 120)
  const company = String(req.body?.company || '').trim().slice(0, 200)
  const address = String(req.body?.address || '').trim().slice(0, 300)
  const nip = String(req.body?.nip || '').replace(/\D/g, '')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Podaj poprawny e-mail.' })
  if (!company) return res.status(400).json({ error: 'Podaj nazwę firmy albo imię i nazwisko.' })
  if (!address) return res.status(400).json({ error: 'Podaj adres do faktury.' })
  if (nip && nip.length !== 10) return res.status(400).json({ error: 'NIP ma 10 cyfr.' })
  if (!req.body?.terms) return res.status(400).json({ error: 'Zaakceptuj regulamin.' })
  if (!req.body?.instant) return res.status(400).json({ error: 'Potwierdź dostarczenie klucza od razu po płatności.' })

  const order = {
    id: crypto.randomBytes(18).toString('base64url'),
    email, company, address, nip,
    amount: cfg.price,
    status: 'pending',
    channel: channelOf(req.body?.utm, String(req.body?.ref || '').toLowerCase() === req.hostname ? '' : req.body?.ref),
    createdAt: new Date().toISOString()
  }
  writeOrder(order)
  record('checkouts', { channel: order.channel })
  try {
    const data = await p24('POST', '/transaction/register', {
      merchantId: cfg.merchantId,
      posId: cfg.posId,
      sessionId: order.id,
      amount: order.amount,
      currency: 'PLN',
      description: 'Licencja OFFaktura',
      email,
      client: company,
      country: 'PL',
      language: 'pl',
      urlReturn: `${cfg.publicUrl}/dziekujemy?s=${order.id}`,
      urlStatus: `${cfg.publicUrl}/api/p24/status`,
      sign: sign({ sessionId: order.id, merchantId: cfg.merchantId, amount: order.amount, currency: 'PLN', crc: cfg.crc })
    })
    const token = data?.data?.token
    if (!token) throw new Error('P24 nie zwrócił tokenu')
    res.json({ url: `${p24Host}/trnRequest/${token}` })
  } catch (err) {
    console.error('checkout', err)
    res.status(502).json({ error: 'Nie udało się połączyć z Przelewy24. Spróbuj ponownie za chwilę.' })
  }
})

app.post('/api/p24/status', async (req, res) => {
  const n = req.body || {}
  const expected = sign({
    merchantId: n.merchantId, posId: n.posId, sessionId: n.sessionId, amount: n.amount,
    originAmount: n.originAmount, currency: n.currency, orderId: n.orderId, methodId: n.methodId,
    statement: n.statement, crc: cfg.crc
  })
  if (!salesOpen() || n.sign !== expected || n.merchantId !== cfg.merchantId) return res.status(400).end()
  const order = readOrder(String(n.sessionId))
  if (!order || order.amount !== n.amount || n.currency !== 'PLN') return res.status(400).end()
  if (order.status === 'paid') return res.json({ ok: true })
  try {
    const verified = await p24('PUT', '/transaction/verify', {
      merchantId: cfg.merchantId,
      posId: cfg.posId,
      sessionId: order.id,
      amount: order.amount,
      currency: 'PLN',
      orderId: n.orderId,
      sign: sign({ sessionId: order.id, orderId: n.orderId, amount: order.amount, currency: 'PLN', crc: cfg.crc })
    })
    if (verified?.data?.status !== 'success') throw new Error('P24 nie potwierdził płatności')
    order.status = 'paid'
    order.p24OrderId = n.orderId
    order.paidAt = new Date().toISOString()
    order.license = issueLicense(order)
    writeOrder(order)
    record('paid', { channel: order.channel || 'nieznane' })
  } catch (err) {
    console.error('verify', err)
    return res.status(500).end()
  }
  res.json({ ok: true })
  try {
    await sendMail(order.email, 'Twój klucz licencji OFFaktura', customerMail(order))
    await sendMail(cfg.notify, `Sprzedaż OFFaktury: ${order.company}`, ownerMail(order))
    order.mailedAt = new Date().toISOString()
    writeOrder(order)
  } catch (err) {
    console.error('mail', err)
  }
})

app.get('/api/order/:id', (req, res) => {
  const order = readOrder(req.params.id)
  if (!order) return res.status(404).json({ status: 'missing' })
  res.json({ status: order.status, license: order.status === 'paid' ? order.license : undefined, email: order.email })
})

function statsAuthorized(req) {
  const [scheme, value] = String(req.get('authorization') || '').split(' ')
  if (scheme !== 'Basic' || !value) return false
  const password = Buffer.from(value, 'base64').toString('utf8').split(':').slice(1).join(':')
  const digest = text => crypto.createHash('sha256').update(text).digest()
  return crypto.timingSafeEqual(digest(password), digest(cfg.statsToken))
}

let releaseCache = { at: 0, list: [] }
async function releaseDownloads() {
  if (Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache.list
  try {
    const res = await fetch('https://api.github.com/repos/mkucharski8/OFFaktura/releases?per_page=50', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'offaktura-site' },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const list = (await res.json()).map(release => ({
      tag: release.tag_name,
      date: String(release.published_at || '').slice(0, 10),
      count: release.assets.filter(asset => asset.name.endsWith('.exe')).reduce((sum, asset) => sum + asset.download_count, 0)
    }))
    releaseCache = { at: Date.now(), list }
  } catch (err) {
    console.error('github', err.message)
  }
  return releaseCache.list
}

const esc = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
const pct = (part, whole) => whole ? `${(100 * part / whole).toFixed(1).replace('.', ',')}%` : '–'

function table(title, rows, columns, note = '') {
  const head = columns.map(([label]) => `<th>${label}</th>`).join('')
  const body = rows.length
    ? rows.map(row => `<tr>${columns.map(([, get]) => `<td>${esc(get(row))}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="muted">Brak danych</td></tr>`
  return `<h2>${title}</h2>${note ? `<p class="muted">${note}</p>` : ''}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

app.get('/statystyki', async (req, res) => {
  if (!cfg.statsToken) return res.status(404).end()
  if (!statsAuthorized(req)) {
    if (limited(req.ip)) return res.status(429).send('Za dużo prób. Spróbuj za kilka minut.')
    return res.set('WWW-Authenticate', 'Basic realm="OFFaktura statystyki", charset="UTF-8"').status(401).send('Podaj hasło.')
  }
  flushStats()
  const span = Math.min(Math.max(Number(req.query.dni) || 30, 1), 365)
  const days = Array.from({ length: span }, (_, i) => warsawDay(new Date(Date.now() - i * 24 * 60 * 60 * 1000)))
  const total = {}
  const groups = { channels: {}, pages: {}, devices: {} }
  const daily = days.map(day => {
    const stats = dayStats(day)
    for (const metric of METRICS) total[metric] = (total[metric] || 0) + (stats[metric] || 0)
    for (const group of Object.keys(groups)) {
      for (const [key, row] of Object.entries(stats[group] || {})) {
        const target = groups[group][key] || (groups[group][key] = {})
        for (const metric of METRICS) target[metric] = (target[metric] || 0) + (row[metric] || 0)
      }
    }
    return { day, ...stats }
  })
  const sorted = (group, metric) => Object.entries(groups[group]).map(([key, row]) => ({ key, ...row })).sort((a, b) => (b[metric] || 0) - (a[metric] || 0))
  const n = value => value || 0
  const releases = await releaseDownloads()
  const card = (label, value, sub = '') => `<div class="card"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`

  res.set('Cache-Control', 'no-store').send(`<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Statystyki · OFFaktura</title>
<style>
  body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #f4f1ea; color: #18211c; }
  main { width: min(1040px, calc(100% - 32px)); margin: 32px auto 60px; }
  h1 { margin: 0 0 6px; letter-spacing: -0.03em; }
  h2 { margin: 36px 0 10px; font-size: 1.15rem; }
  .muted { color: #5a6860; font-size: 0.9rem; }
  nav a { margin-right: 12px; color: #1f3d32; }
  nav a.on { font-weight: 700; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 22px; }
  .card { background: #fffdf8; border: 1px solid #e3ddd1; border-radius: 14px; padding: 14px 16px; }
  .card span { display: block; color: #5a6860; font-size: 0.85rem; }
  .card b { display: block; font-size: 1.7rem; letter-spacing: -0.02em; }
  .card small { color: #5a6860; }
  table { width: 100%; border-collapse: collapse; background: #fffdf8; border: 1px solid #e3ddd1; border-radius: 12px; overflow: hidden; font-size: 0.92rem; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #eee8dc; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { background: #f0ebe1; font-weight: 600; color: #5a6860; }
</style></head><body><main>
<h1>Statystyki OFFaktury</h1>
<p class="muted">Ostatnie ${span} dni (czas polski). Liczone bez ciasteczek i bez adresów IP, więc to są wejścia, a nie unikalne osoby.</p>
<nav>${[7, 30, 90, 365].map(d => `<a href="?dni=${d}" class="${d === span ? 'on' : ''}">${d} dni</a>`).join('')}</nav>
<div class="cards">
  ${card('Wejścia', n(total.entries))}
  ${card('Odsłony', n(total.views))}
  ${card('Kliknięcia „Pobierz”', n(total.downloads), pct(n(total.downloads), n(total.entries)) + ' wejść')}
  ${card('Rozpoczęte zakupy', n(total.checkouts))}
  ${card('Opłacone licencje', n(total.paid), `${(n(total.paid) * cfg.price / 100).toFixed(2).replace('.', ',')} zł`)}
</div>
${table('Źródła wejść', sorted('channels', 'entries'), [
    ['Źródło · kampania · reklama', r => r.key],
    ['Wejścia', r => n(r.entries)],
    ['Pobrania', r => n(r.downloads)],
    ['Pobrania / wejścia', r => pct(n(r.downloads), n(r.entries))],
    ['Zakupy rozpoczęte', r => n(r.checkouts)],
    ['Opłacone', r => n(r.paid)]
  ], 'Reklamy rozpoznajesz po parametrach utm w linku, np. facebook · start · wyciek. Wejścia bez utm są przypisane do strony, z której ktoś przyszedł.')}
${table('Urządzenia', sorted('devices', 'entries'), [
    ['Urządzenie', r => r.key],
    ['Wejścia', r => n(r.entries)],
    ['Odsłony', r => n(r.views)],
    ['Pobrania', r => n(r.downloads)]
  ])}
${table('Podstrony', sorted('pages', 'views'), [
    ['Podstrona', r => r.key],
    ['Odsłony', r => n(r.views)],
    ['Pobrania', r => n(r.downloads)]
  ])}
${table('Dzień po dniu', daily, [
    ['Dzień', r => r.day],
    ['Wejścia', r => n(r.entries)],
    ['Odsłony', r => n(r.views)],
    ['Pobrania', r => n(r.downloads)],
    ['Zakupy rozpoczęte', r => n(r.checkouts)],
    ['Opłacone', r => n(r.paid)]
  ])}
${table('Pobrania instalatora z GitHuba', releases, [
    ['Wersja', r => r.tag],
    ['Wydana', r => r.date],
    ['Pobrania', r => r.count]
  ], 'Licznik GitHuba za cały czas. Obejmuje też pobrania przez automatyczną aktualizację w programie.')}
</main></body></html>`)
})

app.get(['/landing', '/landing/'], (_req, res) => {
  res.sendFile(index)
})

app.get('/dziekujemy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dziekujemy.html')))
app.get('/regulamin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'regulamin.html')))
app.get('/prywatnosc', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'prywatnosc.html')))

app.use(express.static(path.join(__dirname, 'public')))

const server = app.listen(port, () => {
  console.log(`OFFaktura site http://localhost:${port} · sprzedaż ${salesOpen() ? 'włączona' : 'wyłączona'} · P24 ${cfg.sandbox ? 'sandbox' : 'produkcja'}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    flushStats()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
