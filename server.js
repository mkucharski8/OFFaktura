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
  publicUrl: (process.env.PUBLIC_URL || 'https://offaktura-production.up.railway.app').replace(/\/$/, ''),
  price: Number(process.env.PRICE_GROSZE) || 4900,
  privateKey: (process.env.LICENSE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  resendKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'OFFaktura <onboarding@resend.dev>',
  notify: process.env.ORDER_NOTIFY_EMAIL || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data')
}
const p24Host = process.env.P24_HOST || (cfg.sandbox ? 'https://sandbox.przelewy24.pl' : 'https://secure.przelewy24.pl')
const salesOpen = () => Boolean(cfg.merchantId && cfg.posId && cfg.crc && cfg.apiKey && cfg.privateKey)

const ordersDir = path.join(cfg.dataDir, 'orders')
fs.mkdirSync(ordersDir, { recursive: true })
const orderFile = id => path.join(ordersDir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
const readOrder = id => {
  try { return JSON.parse(fs.readFileSync(orderFile(id), 'utf8')) } catch { return null }
}
const writeOrder = order => fs.writeFileSync(orderFile(order.id), JSON.stringify(order, null, 2))

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
    `Kwota: ${(order.amount / 100).toFixed(2)} zł brutto`,
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
app.use(express.json({ limit: '20kb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'offaktura' })
})

app.get('/api/config', (_req, res) => {
  res.json({ salesOpen: salesOpen(), price: cfg.price })
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
    createdAt: new Date().toISOString()
  }
  writeOrder(order)
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

app.get(['/landing', '/landing/'], (_req, res) => {
  res.sendFile(index)
})

app.get('/dziekujemy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dziekujemy.html')))
app.get('/regulamin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'regulamin.html')))
app.get('/prywatnosc', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'prywatnosc.html')))

app.use(express.static(path.join(__dirname, 'public')))

app.listen(port, () => {
  console.log(`OFFaktura site http://localhost:${port} · sprzedaż ${salesOpen() ? 'włączona' : 'wyłączona'} · P24 ${cfg.sandbox ? 'sandbox' : 'produkcja'}`)
})
