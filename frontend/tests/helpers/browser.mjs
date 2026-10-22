import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

export async function startBrowserApp() {
  const dist = new URL('../../dist/', import.meta.url)
  const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  const server = createServer(async (request, response) => {
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
  try {
    const browser = await chromium.launch({ headless: true })
    return {
      browser,
      baseURL: `http://127.0.0.1:${server.address().port}`,
      async close() {
        await browser.close()
        await new Promise(resolve => server.close(resolve))
      },
    }
  } catch (error) {
    await new Promise(resolve => server.close(resolve))
    throw error
  }
}
