import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { startBrowserApp } from './helpers/browser.mjs'

const clip = await readFile(new URL('./fixtures/playback.webm', import.meta.url))
let app
before(async () => { app = await startBrowserApp() })
after(async () => { await app?.close() })

function video(key, kind = 'http', extra = {}) {
  return {
    id: 'multi-file-job', key, kind, title: `${key}.webm`, filename: `${key}.webm`,
    mime: 'video/webm', size: clip.length, created: 1, available: true,
    download_url: `/api/history/files/${key}`, stream_url: `/api/history/files/${key}?inline=true`,
    ...extra,
  }
}

async function openHistory(t, records, { kind = 'http', lang = 'en', width = 1100, jobs = [] } = {}) {
  const page = await app.browser.newPage({ viewport: { width, height: 800 }, acceptDownloads: true })
  t.after(() => page.close())
  page.setDefaultTimeout(8000)
  await page.addInitScript(({ kind, lang }) => {
    localStorage.setItem('lang', lang)
    localStorage.setItem('tab', kind)
  }, { kind, lang })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  const state = {
    records, files: new Map(records.map(record => [record.key, record])),
    requests: [], deleted: new Set(), broken: new Set(), events: new Map(),
  }
  for (const job of jobs) {
    let resolve
    const promise = new Promise(done => { resolve = done })
    state.events.set(job.id, { promise, resolve })
  }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/jobs') return route.fulfill({ json: jobs })
    if (path.endsWith('/events')) {
      const id = path.split('/')[3]
      await state.events.get(id).promise
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({
        ...jobs.find(job => job.id === id), status: 'done', phase: 'done', progress: 100,
      })}\n\n` })
    }
    if (path === '/api/history') {
      const filtered = state.records.filter(record => record.kind === url.searchParams.get('kind'))
      const pageNumber = Number(url.searchParams.get('page') || 1)
      return route.fulfill({ json: {
        items: filtered.slice((pageNumber - 1) * 10, pageNumber * 10), total: filtered.length,
        page: pageNumber, page_size: 10,
      } })
    }
    if (path.startsWith('/api/history/files/')) {
      const key = path.split('/').pop()
      const method = route.request().method()
      const inline = url.searchParams.has('inline')
      state.requests.push({ key, method, inline })
      const record = state.files.get(key)
      if (!record || state.deleted.has(key)) return route.fulfill({ status: 404, body: 'File unavailable' })
      const body = state.broken.has(key) ? Buffer.from('invalid video') : clip
      const headers = {
        'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${record.filename}"`,
      }
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/)
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`
      headers['Content-Length'] = String(end - start + 1)
      return route.fulfill({ status: range ? 206 : 200, headers, body: method === 'HEAD' ? '' : body.subarray(start, end + 1) })
    }
    if (path === '/api/settings') return route.fulfill({ json: {
      cookies_configured: false, bilibili_cookies_configured: false, proxy: '', js_runtimes: '',
    } })
    return route.fulfill({ status: 404, json: { detail: 'Not found' } })
  })
  await page.goto(app.baseURL)
  await page.locator('.history-row').first().waitFor()
  return { page, state }
}

async function play(page, index = 0) {
  await page.locator('.play-btn').nth(index).click()
  await page.locator('dialog[open]').waitFor()
  await page.waitForFunction(() => {
    const video = document.querySelector('dialog video')
    return video && video.readyState >= 2 && !video.paused && video.currentTime > 0
  })
  return page.locator('dialog video')
}

test('a real video plays, pauses, seeks, enters fullscreen and stops on Escape with focus restored', async t => {
  const { page, state } = await openHistory(t, [video('first'), video('second'),
    video('audio', 'http', { stream_url: null, mime: 'audio/opus' }),
    video('archive', 'http', { stream_url: null, mime: 'application/zip' }),
    video('expired', 'http', { stream_url: null, available: false }),
  ])
  assert.equal(await page.locator('.play-btn').count(), 2)
  assert.equal(state.requests.length, 0, 'listing history must not preload media')
  const media = await play(page)
  const previous = await media.elementHandle()
  const details = await media.evaluate(video => ({ controls: video.controls, inline: video.playsInline, duration: video.duration, src: video.currentSrc }))
  assert.ok(details.controls && details.inline)
  assert.ok(details.duration >= 8 && details.duration < 9)
  assert.match(details.src, /\/first\?inline=true$/)
  await media.evaluate(video => { video.pause(); video.currentTime = 5; video.volume = 0.35 })
  await page.waitForFunction(() => {
    const video = document.querySelector('dialog video')
    return !video.seeking && Math.abs(video.currentTime - 5) < 0.2
  })
  assert.equal(await media.evaluate(video => video.paused), true)
  assert.equal(await media.evaluate(video => video.volume), 0.35)
  await media.evaluate(video => video.requestFullscreen())
  assert.equal(await page.evaluate(() => document.fullscreenElement?.tagName), 'VIDEO')
  await page.evaluate(() => document.exitFullscreen())
  const downloading = page.waitForEvent('download')
  await page.locator('dialog a').click()
  const download = await downloading
  assert.equal(download.suggestedFilename(), 'first.webm')
  assert.deepEqual(await readFile(await download.path()), clip)
  await page.keyboard.press('Escape')
  await page.locator('dialog').waitFor({ state: 'detached' })
  assert.deepEqual(await previous.evaluate(video => ({ paused: video.paused, src: video.getAttribute('src') })), { paused: true, src: null })
  assert.equal(await page.locator('.play-btn').first().evaluate(button => button === document.activeElement), true)
  const second = await play(page, 1)
  assert.match(await second.getAttribute('src'), /\/second\?inline=true$/)
  assert.equal(await page.locator('video').count(), 1)
  await page.getByRole('button', { name: 'Close', exact: false }).click()
  await page.locator('dialog').waitFor({ state: 'detached' })
})

for (const kind of ['youtube', 'bilibili', 'bt']) {
  test(`the ${kind} source plays its own precise history file and stops when the source changes`, async t => {
    const { page } = await openHistory(t, [video(`${kind}-file`, kind)], { kind })
    const media = await play(page)
    const previous = await media.elementHandle()
    assert.match(await media.getAttribute('src'), new RegExp(`/${kind}-file\\?inline=true$`))
    await page.evaluate(() => document.querySelector('nav.tabs button').click())
    await page.locator('dialog').waitFor({ state: 'detached' })
    assert.equal(await previous.evaluate(video => video.paused && !video.getAttribute('src')), true)
  })
}

for (const failure of ['broken', 'missing']) {
  test(`${failure} media gives a localized failure with download fallback`, async t => {
    const { page, state } = await openHistory(t, [video('failure')], { lang: 'zh', width: 320 })
    state[failure === 'broken' ? 'broken' : 'deleted'].add('failure')
    await page.locator('.play-btn').click()
    await page.locator('dialog [role=alert]').waitFor()
    assert.match(await page.locator('dialog [role=alert]').innerText(), /视频无法播放/)
    assert.equal(await page.locator('dialog a').innerText(), '下载文件')
    assert.equal(await page.locator('dialog').evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('dialog').evaluate(dialog => dialog.contains(document.activeElement)), true)
    if (failure === 'broken') await page.screenshot({ path: '/tmp/video-playback-mobile.png', fullPage: true })
    await page.keyboard.press('Escape')
    await page.locator('dialog').waitFor({ state: 'detached' })
  })
}

test('history refresh keeps a playing record that moved off-page, then stops it if deleted elsewhere', async t => {
  const jobs = ['refresh-one', 'refresh-two'].map(id => ({
    id, kind: 'http', status: 'running', phase: 'downloading', title: id, progress: 0,
    current: 0, total: 1, error: null, download_url: null, download_urls: [],
  }))
  const { page, state } = await openHistory(t, [video('playing')], { jobs })
  const media = await play(page)
  const previous = await media.elementHandle()
  state.records = [video('new-file')]
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/history')
  state.events.get('refresh-one').resolve()
  await refreshed
  await page.locator('.history-title').filter({ hasText: 'new-file.webm' }).waitFor()
  await page.waitForFunction(() => !!document.querySelector('dialog video')?.currentTime)
  assert.equal(await previous.evaluate(video => video === document.querySelector('dialog video') && !video.paused), true)
  assert.equal(state.requests.some(request => request.key === 'playing' && request.method === 'HEAD'), true)
  state.deleted.add('playing')
  state.events.get('refresh-two').resolve()
  await page.locator('dialog').waitFor({ state: 'detached' })
  assert.match(await page.locator('.history-notice').innerText(), /no longer available/)
  assert.equal(await previous.evaluate(video => video.paused && !video.getAttribute('src')), true)
})

test('an availability refresh stops a video whose file expired', async t => {
  const job = { id: 'refresh-expired', kind: 'http', status: 'running', progress: 0,
    phase: 'downloading', title: 'Other download', error: null, download_url: null, download_urls: [] }
  const { page, state } = await openHistory(t, [video('expires')], { jobs: [job] })
  const media = await play(page)
  const previous = await media.elementHandle()
  state.records = [video('expires', 'http', { available: false, stream_url: null })]
  state.events.get(job.id).resolve()
  await page.locator('dialog').waitFor({ state: 'detached' })
  assert.match(await page.locator('.history-notice').innerText(), /no longer available/)
  assert.equal(await previous.evaluate(video => video.paused && !video.getAttribute('src')), true)
  assert.equal(await page.locator('.play-btn').count(), 0)
})

test('playback preserves history selection and changing pages releases the video', async t => {
  const { page } = await openHistory(t, Array.from({ length: 11 }, (_, index) => video(`page-${index}`)))
  const checkbox = page.locator('.history-row input[type=checkbox]').first()
  await checkbox.check()
  await play(page)
  await page.getByRole('button', { name: 'Close', exact: false }).click()
  assert.equal(await checkbox.isChecked(), true)
  const media = await play(page)
  const previous = await media.elementHandle()
  await page.evaluate(() => document.querySelector('.history-pager button:last-child').click())
  await page.locator('dialog').waitFor({ state: 'detached' })
  await page.locator('.history-title').filter({ hasText: 'page-10.webm' }).waitFor()
  assert.equal(await previous.evaluate(video => video.paused && !video.getAttribute('src')), true)
  assert.equal(await page.locator('.history-row input[type=checkbox]').first().isChecked(), false)
})
