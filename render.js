const puppeteer = require('puppeteer')
const spawn = require('child_process').spawn
const { once } = require('events')
const tkt = require('tkt')
const fs = require('fs')
const path = require('path')

// Windows named pipes reject large writes (errno -4094 / UNKNOWN).
const PIPE_CHUNK_SIZE = 64 * 1024

function createRendererFactory(
  url,
  { scale = 1, alpha = false, launchArgs = [] } = {},
) {
  const DATA_URL_PREFIX = 'data:image/png;base64,'
  return function createRenderer({ name = 'Worker' } = {}) {
    const promise = (async () => {
      const browser = await puppeteer.launch({
        args: launchArgs,
      })
      const page = await browser.newPage()
      page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))
      page.on('pageerror', (msg) => console.log('PAGE ERROR:', msg))
      await page.goto(url, { waitUntil: 'load' })
      const dimensions = await page.evaluate(`(async () => {
        let deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          const scene = document.querySelector('#scene')
          if (scene && scene.offsetWidth && scene.offsetHeight) {
            return { width: scene.offsetWidth, height: scene.offsetHeight }
          }
          await new Promise(r => setTimeout(r, 100))
        }
        throw new Error('Timed out waiting for #scene dimensions')
      })()`)
      await page.setViewport({
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: scale,
      })
      const info = await page.evaluate(
        async (width, height) => {
          let deadline = Date.now() + 10000
          while (Date.now() < deadline) {
            if (typeof getInfo === 'function') {
              break
            }
            await new Promise((r) => setTimeout(r, 100))
          }
          if (typeof getInfo !== 'function') {
            throw new Error('Timed out waiting for getInfo()')
          }
          const info = await getInfo()
          Object.assign(info, { width, height })
          return info
        },
        dimensions.width,
        dimensions.height,
      )
      return { browser, page, info }
    })()
    let rendering = false
    return {
      async getInfo() {
        return (await promise).info
      },
      async render(i) {
        if (rendering) {
          throw new Error('render() may not be called concurrently!')
        }
        rendering = true
        try {
          const marks = [Date.now()]
          const { page, info } = await promise
          marks.push(Date.now())
          const result = await page.evaluate(frame => seekToFrame(frame), i)
          marks.push(Date.now())
          const buffer =
            typeof result === 'string' && result.startsWith(DATA_URL_PREFIX)
              ? Buffer.from(result.substr(DATA_URL_PREFIX.length), 'base64')
              : await page.screenshot({
                  clip: { x: 0, y: 0, width: info.width, height: info.height },
                  omitBackground: alpha,
                })
          marks.push(Date.now())
          console.log(
            name,
            `render(${i}) finished`,
            `timing=${marks
              .map((v, i, a) => (i === 0 ? null : v - a[i - 1]))
              .slice(1)}`,
          )
          return buffer
        } finally {
          rendering = false
        }
      },
      async end() {
        const { browser } = await promise
        browser.close()
      },
    }
  }
}

function createParallelRender(max, rendererFactory) {
  const available = []
  const working = new Set()
  let nextWorkerId = 1
  let waiting = null
  function obtainWorker() {
    if (available.length + working.size < max) {
      const id = nextWorkerId++
      const worker = { id, renderer: rendererFactory(`Worker ${id}`) }
      available.push(worker)
      console.log('Spawn worker %d', worker.id)
      if (waiting) waiting.nudge()
    }
    if (available.length > 0) {
      const worker = available.shift()
      working.add(worker)
      return worker
    }
    return null
  }
  const work = async (fn, taskDescription) => {
    for (;;) {
      const worker = obtainWorker()
      if (!worker) {
        if (!waiting) {
          let nudge
          const promise = new Promise((resolve) => {
            nudge = () => {
              waiting = null
              resolve()
            }
          })
          waiting = { promise, nudge }
        }
        await waiting.promise
        continue
      }
      try {
        console.log('Worker %d: %s', worker.id, taskDescription)
        const result = await fn(worker.renderer)
        available.push(worker)
        if (waiting) waiting.nudge()
        return result
      } catch (e) {
        worker.renderer.end()
        throw e
      } finally {
        working.delete(worker)
      }
    }
  }
  return {
    async getInfo() {
      return work((r) => r.getInfo(), 'getInfo')
    },
    async render(i) {
      return work((r) => r.render(i), `render(${i})`)
    },
    async end() {
      return Promise.all(
        [...available, ...working].map((r) => r.renderer.end()),
      )
    },
  }
}

function ffmpegOutput(fps, outPath, { alpha, vulkan }) {
  const useVulkan = Boolean(alpha && vulkan)
  const encoder = useVulkan
    ? 'prores_ks_vulkan (GPU)'
    : alpha
      ? 'prores_ks (CPU)'
      : 'libx264 (CPU)'
  console.log('ffmpeg encoder:', encoder)

  const ffmpeg = spawn('ffmpeg', [
    ...(useVulkan
      ? ['-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk']
      : []),
    ...['-f', 'image2pipe'],
    ...['-framerate', `${fps}`],
    ...['-i', '-'],
    ...(alpha
      ? useVulkan
        ? [
            ...['-vf', 'format=yuva444p10le,hwupload'],
            ...['-c:v', 'prores_ks_vulkan'],
            ...['-profile:v', '4444'],
          ]
        : [
            // https://stackoverflow.com/a/12951156/559913
            // ...['-c:v', 'qtrle'],

            // https://unix.stackexchange.com/a/111897
            // premiere friendly
            ...['-c:v', 'prores_ks'],
            ...['-pix_fmt', 'yuva444p10le'],
            ...['-profile:v', '4444'],
            // https://www.ffmpeg.org/ffmpeg-codecs.html#Speed-considerations
            // ...['-qscale', '4']
          ]
      : [
          ...['-c:v', 'libx264'],
          ...['-crf', '16'],
          ...['-preset', 'ultrafast'],
          // https://trac.ffmpeg.org/wiki/Encode/H.264#Encodingfordumbplayers
          ...['-pix_fmt', 'yuv420p'],
        ]),
    '-y',
    outPath,
  ])
  ffmpeg.stderr.pipe(process.stderr)
  ffmpeg.stdout.pipe(process.stdout)

  let stdinError = null
  ffmpeg.stdin.on('error', (err) => {
    stdinError = err
  })
  ffmpeg.on('error', (err) => {
    stdinError = stdinError || err
  })

  async function writeFully(buffer) {
    if (stdinError) throw stdinError
    if (!ffmpeg.stdin.writable) {
      throw stdinError || new Error('ffmpeg stdin is closed')
    }
    for (let offset = 0; offset < buffer.length; ) {
      if (stdinError) throw stdinError
      const chunk = buffer.subarray(
        offset,
        Math.min(offset + PIPE_CHUNK_SIZE, buffer.length),
      )
      offset += chunk.length
      let ok
      try {
        ok = ffmpeg.stdin.write(chunk)
      } catch (err) {
        throw stdinError || err
      }
      if (!ok) await once(ffmpeg.stdin, 'drain')
    }
  }

  return {
    async writePNGFrame(buffer, _frameNumber) {
      await writeFully(buffer)
    },
    async end() {
      if (ffmpeg.stdin.writable) {
        ffmpeg.stdin.end()
      }
      const [code, signal] = await once(ffmpeg, 'close')
      if (code && code !== 0) {
        throw new Error(
          `ffmpeg exited with code ${code}${signal ? ` signal ${signal}` : ''}`,
        )
      }
    },
    destroy() {
      try {
        if (ffmpeg.stdin.writable) ffmpeg.stdin.destroy()
      } catch (_) {}
      if (!ffmpeg.killed) ffmpeg.kill()
    },
  }
}

function pngFileOutput(dirname) {
  require('mkdirp').sync(dirname)
  return {
    writePNGFrame(buffer, frameNumber) {
      const basename = 'frame' + `${frameNumber}`.padStart(6, '0') + '.png'
      fs.writeFileSync(path.join(dirname, basename), buffer)
    },
    end() {},
  }
}

tkt
  .cli()
  .command(
    '$0',
    'Renders a video',
    {
      url: {
        description: 'The URL to render',
        type: 'string',
        default: `file://${__dirname}/examples/gsap-hello-world.html?render`,
      },
      video: {
        description:
          'The path to video file to render. Without `--alpha` this MUST be .mp4, and with `--alpha` this MUST be .mov',
        type: 'string',
        default: 'video.mp4',
      },
      parallelism: {
        description:
          'How many headless Chrome processes to use to render in parallel',
        type: 'number',
        default: require('os').cpus().length,
      },
      start: {
        description: 'Time in seconds to start rendering',
        type: 'number',
        default: 0,
      },
      end: {
        description:
          'Time in seconds to end rendering (that time will not be rendered)',
        type: 'number',
      },
      frame_start: {
        description: 'Frame number to start rendering',
        type: 'number',
      },
      frame_end: {
        description:
          'Frame number to end rendering (that frame number will not be rendered)',
        type: 'number',
      },
      png: {
        description: 'Directory for PNG frame output',
        type: 'string',
      },
      alpha: {
        description:
          'Renders a image/video with alpha transparency. For video, the file extension MUST be .mov',
        type: 'boolean',
      },
      vulkan: {
        description:
          'Encode ProRes 4444 with prores_ks_vulkan (GPU). Requires --alpha and FFmpeg 8.1+',
        type: 'boolean',
      },
      scale: {
        description: 'Device scale factor',
        type: 'number',
        default: 1,
      },
    },
    async function main(args) {
      const startTime = Date.now()
      if (args.vulkan && !args.alpha) {
        console.log(
          'Note: --vulkan only applies to ProRes with --alpha; ignoring for this run',
        )
      }
      // 1) Prepara la fábrica de renderers y un renderer para obtener info
      const mkRenderer = createRendererFactory(args.url, {
        scale: args.scale,
        alpha: args.alpha,
      })

      const infoRenderer = mkRenderer({ name: 'Info' })
      const info = await infoRenderer.getInfo()
      console.log('Movie info:', info)

      const outputs = []
      if (args.video) {
        outputs.push(
          ffmpegOutput(info.fps, args.video, {
            alpha: args.alpha,
            vulkan: args.vulkan,
          }),
        )
      }
      if (args.png != null) {
        outputs.push(pngFileOutput(args.png))
      }

      const fps = info.fps
      const frameStart = args.frame_start != null ? args.frame_start : args.frameStart
      const frameEnd = args.frame_end != null ? args.frame_end : args.frameEnd
      const start =
        frameStart != null
          ? frameStart
          : Math.round((args.start || 0) * fps)
      const end =
        frameEnd != null
          ? frameEnd
          : args.end != null
            ? Math.round(args.end * fps)
            : info.numberOfFrames
      console.log(
        'Render range: frames [%d, %d) @ %d fps',
        start,
        end,
        fps,
      )
      const totalFrames = Math.max(0, end - start)
      if (totalFrames === 0) {
        for (const o of outputs) await o.end()
        await infoRenderer.end()
        return
      }

      // 2) Crea N workers fijos (uno por paralelo) y divide el rango en segmentos contiguos
      const parallelism = Math.min(args.parallelism || require('os').cpus().length, totalFrames)
      const workers = new Array(parallelism)
      workers[0] = infoRenderer // Reaprovechamos el que ya abrió el browser
      for (let w = 1; w < parallelism; w++) {
        workers[w] = mkRenderer({ name: `Worker ${w + 1}` })
      }

      const chunkSize = Math.ceil(totalFrames / parallelism)

      // 3) Esquema de escritura en orden (coordinador)
      const pending = new Map()         // frameNumber -> Buffer
      let nextToWrite = start
      let writeQueue = Promise.resolve()

      function deliver(frame, buffer) {
        pending.set(frame, buffer)
        writeQueue = writeQueue.then(async () => {
          while (pending.has(nextToWrite)) {
            const buf = pending.get(nextToWrite)
            pending.delete(nextToWrite)
            for (const o of outputs) await o.writePNGFrame(buf, nextToWrite)
            nextToWrite++
          }
        })
        return writeQueue
      }

      try {
        // 4) Lanza un job por worker: cada uno recorre su segmento en orden ascendente
        const jobs = workers.map(async (renderer, idx) => {
          const from = start + idx * chunkSize
          const to = Math.min(end, from + chunkSize)
          if (from >= to) return

          console.log(`Worker ${idx + 1} -> frames [${from}, ${to}]`)
          for (let i = from; i < to; i++) {
            // Render en secuencia para este worker
            const buffer = await renderer.render(i)
            await deliver(i, buffer)
          }
        })

        // 5) Espera a que terminen todos los segmentos y se vacíe el pipe a ffmpeg
        await Promise.all(jobs)
        await writeQueue

        // 6) Cierra salidas
        for (const o of outputs) await o.end()
      } catch (err) {
        for (const o of outputs) {
          if (typeof o.destroy === 'function') o.destroy()
        }
        throw err
      } finally {
        await Promise.all(workers.map((w) => w.end()))
      }
      const endTime = Date.now()
      const diff = Math.floor((endTime - startTime)/1000)
      const mins = Math.floor(diff / 60)
      const secs = (diff % 60).toString().padStart(2, '0')
      console.log(`Render time: ${mins}:${secs}`)
    },
  )
  .command('server', 'Starts a rendering server', {}, async () => {
    const express = require('express')
    const app = express()
    app.use(require('body-parser').json())
    let currentRenderer
    app.get('/render', async (req, res, next) => {
      try {
        const options = {
          url: String(req.query.url),
          alpha: req.query.alpha === '1',
          scale: +req.query.scale || 1,
        }
        const optionsString = JSON.stringify(options)
        if (!currentRenderer || currentRenderer.options !== optionsString) {
          if (currentRenderer) {
            currentRenderer.renderer.end()
          }
          currentRenderer = {
            renderer: createParallelRender(
              +process.env.HTML5_ANIMATION_VIDEO_RENDERER_PARALLELIZATION || 1,
              createRendererFactory(options.url, {
                scale: options.scale,
                alpha: options.alpha,
                launchArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
              }),
            ),
            options: optionsString,
          }
        }
        const result = await currentRenderer.renderer.render(
          +req.query.frame || 0,
        )
        res.set('Content-Type', 'image/png')
        res.send(result)
      } catch (error) {
        next(error)
      }
    })
    const port = +process.env.PORT || 8080
    const server = await new Promise((resolve) =>
      app.listen(port, function () {
        resolve(this)
      }),
    )
    console.log('Now listening on port ' + port)
    return new Promise(() => {})
  })
  .parse()
