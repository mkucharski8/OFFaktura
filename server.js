const express = require('express')
const path = require('path')

const app = express()
const port = Number(process.env.PORT) || 3000
const index = path.join(__dirname, 'public', 'index.html')

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'offaktura' })
})

app.get(['/landing', '/landing/'], (_req, res) => {
  res.sendFile(index)
})

app.use(express.static(path.join(__dirname, 'public')))

app.listen(port, () => {
  console.log(`OFFaktura site http://localhost:${port}`)
})
