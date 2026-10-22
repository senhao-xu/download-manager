import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'

const dist = new URL('../dist/', import.meta.url)
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
let browser, server, baseURL

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const file = new URL(pathname === '/' ? 'index.html' : `.${pathname}`, dist)
      if (!file.href.startsWith(dist.href)) {
        response.writeHead(403).end()
        return
      }
      const content = await readFile(file)
      const extension = file.pathname.slice(file.pathname.lastIndexOf('.'))
      response.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream' })
      response.end(content)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

function job(id, status = 'queued', extra = {}) {
  return {
    id, kind: 'http', status, progress: 0, current: 0, total: 1, phase: status,
    title: id, error: null, download_url: null, download_urls: [], ...extra,
  }
}

function record(id) {
  return {
    id, key: `${id}-file`, kind: 'http', title: `${id}.txt`, filename: `${id}.txt`,
    size: 10, mime: 'text/plain', source: `https://example.com/${id}.txt`,
    created: 1, available: true, download_url: `/api/history/files/${id}-file`,
  }
}

async function openPage(t, handleRequest, lang = 'en') {
  const page = await browser.newPage({ acceptDownloads: true })
  t.after(() => page.close())
  page.setDefaultTimeout(5000)
  await page.clock.install()
  await page.addInitScript(language => {
    localStorage.setItem('lang', language)
    localStorage.setItem('tab', 'http')
  }, lang)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    await handleRequest(route, path)
  })
  await page.goto(baseURL)
  return page
}

function historyResponse(route, items = []) {
  return route.fulfill({ json: { items, total: items.length, page: 1, page_size: 10 } })
}

test('a partially failed HTTP batch keeps successful files downloadable and its error visible', async t => {
  let started = false
  const file = record('partial')
  const page = await openPage(t, async (route, path) => {
    if (path === '/api/jobs') return route.fulfill({ json: [] })
    if (path === '/api/download-http') {
      started = true
      return route.fulfill({ json: { job_id: file.id } })
    }
    if (path === '/api/jobs/partial') return route.fulfill({
      json: job(file.id, 'error', { total: 2, current: 1, error: 'Second file failed' }),
    })
    if (path === '/api/history') return historyResponse(route, started ? [file] : [])
    if (path === file.download_url) return route.fulfill({
      contentType: 'text/plain', headers: { 'Content-Disposition': 'attachment; filename=partial.txt' },
      body: 'downloaded',
    })
    return route.abort()
  })
  await page.fill('textarea', 'https://example.com/good\nhttps://example.com/bad')
  await page.getByRole('button', { name: 'Start download', exact: true }).click()
  await page.locator('.job.queued').waitFor()
  await page.clock.runFor(1300)
  await page.locator('.job.error').waitFor()
  await page.locator('.history-row').waitFor()
  const downloading = page.waitForEvent('download')
  await page.locator('.history-actions button').first().click()
  const download = await downloading
  assert.equal(download.suggestedFilename(), 'partial.txt')
  assert.equal(await readFile(await download.path(), 'utf8'), 'downloaded')
  await page.clock.runFor(3000)
  assert.match(await page.locator('.job.error').innerText(), /Second file failed/)
  assert.equal(await page.locator('.history-row').count(), 1)
})

test('a missing queued task stops polling while another task completes and deduplicates history', async t => {
  let activeRequests = 0, missingRequests = 0, completedRequests = 0
  const completedFile = record('completed')
  const page = await openPage(t, async (route, path) => {
    if (path === '/api/jobs') return route.fulfill({
      json: ++activeRequests === 1 ? [job('missing'), job('completed')] : [],
    })
    if (path === '/api/jobs/missing') {
      missingRequests++
      return route.fulfill({ status: 404, json: { detail: 'Job not found.' } })
    }
    if (path === '/api/jobs/completed') {
      completedRequests++
      return route.fulfill({ json: job('completed', 'done', {
        progress: 100, download_url: completedFile.download_url, download_urls: [completedFile.download_url],
      }) })
    }
    if (path === '/api/history') return historyResponse(route, [completedFile])
    return route.abort()
  })
  await page.locator('.job.queued').first().waitFor()
  await page.locator('.history-count').filter({ hasText: '1' }).waitFor()
  assert.equal(await page.locator('.history-row').count(), 0)
  let downloads = 0
  page.on('download', () => { downloads++ })
  await page.clock.runFor(1300)
  await page.locator('.job.error').waitFor()
  await page.locator('.job.done').waitFor()
  assert.match(await page.locator('.job.error').innerText(), /Job lost/)
  assert.equal(await page.locator('.history-row').count(), 0)
  await page.clock.runFor(6000)
  await page.locator('.history-row').waitFor()
  assert.equal(await page.locator('.job.queued').count(), 0)
  assert.equal(await page.locator('.job.done').count(), 0)
  assert.equal(missingRequests, 1)
  assert.equal(completedRequests, 1)
  assert.equal(activeRequests, 2)
  assert.equal(downloads, 0, 'restored jobs must not automatically download')
})

for (const failure of ['active list', 'job lookup']) {
  test(`a transient ${failure} error is retried until the queued task finishes`, async t => {
    let activeRequests = 0, lookups = 0
    const page = await openPage(t, async (route, path) => {
      if (path === '/api/jobs') {
        activeRequests++
        if (activeRequests === 1) return route.fulfill({ json: [job('retry')] })
        if (failure === 'active list' && activeRequests === 2) return route.fulfill({ status: 503, body: 'Temporary failure' })
        return route.fulfill({ json: [] })
      }
      if (path === '/api/jobs/retry') {
        lookups++
        if (failure === 'job lookup' && lookups === 1) return route.fulfill({ status: 503, body: 'Temporary failure' })
        return route.fulfill({ json: job('retry', 'done', { progress: 100 }) })
      }
      if (path === '/api/history') return historyResponse(route)
      return route.abort()
    })
    await page.locator('.job.queued').waitFor()
    await page.clock.runFor(1300)
    assert.equal(await page.locator('.job.queued').count(), 1)
    assert.equal(await page.locator('.job.error').count(), 0)
    await page.clock.runFor(1300)
    await page.locator('.job.done').waitFor()
    assert.equal(activeRequests, 3)
    assert.equal(lookups, failure === 'job lookup' ? 2 : 1)
  })
}

test('SSE reconciliation marks a missing running task lost without reconnecting', async t => {
  let streams = 0, lookups = 0
  const page = await openPage(t, async (route, path) => {
    if (path === '/api/jobs') return route.fulfill({ json: [job('running', 'running')] })
    if (path === '/api/jobs/running/events') {
      streams++
      return route.fulfill({ status: 503, body: 'Stream disconnected' })
    }
    if (path === '/api/jobs/running') {
      lookups++
      return route.fulfill({ status: 404, json: { detail: 'Job not found.' } })
    }
    if (path === '/api/history') return historyResponse(route)
    return route.abort()
  }, 'zh')
  await page.locator('.job.error').waitFor()
  assert.match(await page.locator('.job.error').innerText(), /任务丢失/)
  await page.clock.runFor(6000)
  assert.equal(streams, 1)
  assert.equal(lookups, 1)
})
