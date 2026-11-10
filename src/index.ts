import { Context, Schema, h, Logger } from 'koishi'
import enUS from './locales/en-US.json'
import zhCN from './locales/zh-CN.json'
import jaJP from './locales/ja-JP.json'

export const name = 'animeapi'
export const inject = ['http']

const logger = new Logger('animeapi')

const API_URL = 'https://animeapi.ai/api/generate'
const MODELS = ['anime', 'ultra', 'ultra-max'] as const
const ORIENTATIONS = ['portrait', 'square', 'landscape'] as const
const MAX_PROMPT = 1000

type Model = typeof MODELS[number]
type Orientation = typeof ORIENTATIONS[number]

export interface Config {
  apiKey: string
  model: Model
  orientation: Orientation
  enhance: boolean
  cooldown: number
  allowModelOverride: boolean
  showPrompt: boolean
  sendAs: 'file' | 'url'
  timeout: number
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    apiKey: Schema.string().role('secret').default('').description('AnimeAPI key (starts with `ank_`). Create one at https://animeapi.ai/dashboard/api-keys. New accounts get 3 free images.'),
  }).description('AnimeAPI'),
  Schema.object({
    model: Schema.union([
      Schema.const('anime').description('anime: $0.003 per image, fast, best at characters'),
      Schema.const('ultra').description('ultra: $0.01 per image, follows long sentences and renders text'),
      Schema.const('ultra-max').description('ultra-max: $0.02 per image, ultra with finer detail'),
    ]).default('anime').description('Default model.'),
    orientation: Schema.union([
      Schema.const('portrait').description('portrait'),
      Schema.const('square').description('square'),
      Schema.const('landscape').description('landscape'),
    ]).default('portrait').description('Default image shape. The price is the same for every shape.'),
    enhance: Schema.boolean().default(true).description('Let AnimeAPI rewrite plain-language prompts into tags (anime model).'),
  }).description('Image'),
  Schema.object({
    cooldown: Schema.natural().default(30).description('Seconds each user must wait between images. 0 turns the limit off.'),
    allowModelOverride: Schema.boolean().default(false).description('Let users pick a model with `-m`. Off by default so users cannot choose a more expensive model.'),
    showPrompt: Schema.boolean().default(false).description('Reply with the tags the model actually received, below the image.'),
    sendAs: Schema.union([
      Schema.const('file').description('download the image and send the file (recommended)'),
      Schema.const('url').description('send the image URL and let the chat platform fetch it'),
    ]).default('file').description('How the image is sent.'),
    timeout: Schema.natural().default(120).description('Seconds to wait for AnimeAPI before giving up.'),
  }).description('Bot'),
]) as Schema<Config>

interface GenerateResult {
  image_url: string
  enhanced_prompt: string
  balance_usd: number
  generation_time_ms: number
}

interface ApiFailure {
  status: number
  code: string
  message: string
  retryable: boolean
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('en-US', enUS)
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('ja-JP', jaJP)

  const lastUse = new Map<string, number>()
  const inFlight = new Set<string>()

  async function request(body: Record<string, unknown>): Promise<GenerateResult | ApiFailure> {
    for (let attempt = 1; ; attempt++) {
      let failure: ApiFailure
      try {
        const res = await ctx.http(API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          data: body,
          timeout: config.timeout * 1000,
          responseType: 'json',
          validateStatus: () => true,
        })
        const data: any = res.data ?? {}
        if (res.status >= 200 && res.status < 300 && data.image_url) return data as GenerateResult
        const message = typeof data.error === 'string' ? data.error : data.error?.message ?? `HTTP ${res.status}`
        failure = {
          status: res.status,
          code: data.code ?? '',
          message,
          retryable: data.retryable === true || res.status === 500 || res.status === 503,
        }
        if (failure.retryable && attempt < 2) {
          const retryAfter = Number(res.headers?.get?.('retry-after')) || 3
          await sleep(Math.min(retryAfter, 10) * 1000)
          continue
        }
      } catch (error: any) {
        failure = { status: 0, code: 'NETWORK', message: error?.message ?? String(error), retryable: false }
      }
      return failure
    }
  }

  async function toElement(url: string) {
    if (config.sendAs === 'url') return h.image(url)
    try {
      const res = await ctx.http(url, { method: 'GET', responseType: 'arraybuffer', timeout: 60000 })
      const type = res.headers?.get?.('content-type') || (url.endsWith('.png') ? 'image/png' : 'image/webp')
      return h.image(Buffer.from(res.data as ArrayBuffer), type.split(';')[0])
    } catch (error) {
      logger.warn('could not download the image, sending its URL instead: %o', error)
      return h.image(url)
    }
  }

  ctx.command('anime <prompt:text>')
    .alias('animeapi')
    .option('model', '-m <model:string>')
    .option('orientation', '-o <orientation:string>')
    .action(async ({ session, options }, prompt) => {
      if (!session) return
      prompt = (prompt ?? '').trim()
      if (!prompt) return session.text('.no-prompt')
      if (prompt.length > MAX_PROMPT) return session.text('.too-long')
      if (!config.apiKey.trim()) return session.text('.no-key')

      let model: Model = config.model
      if (options?.model) {
        if (!MODELS.includes(options.model as Model)) return session.text('.bad-model')
        if (!config.allowModelOverride && options.model !== config.model) return session.text('.model-locked')
        model = options.model as Model
      }
      let orientation: Orientation = config.orientation
      if (options?.orientation) {
        if (!ORIENTATIONS.includes(options.orientation as Orientation)) return session.text('.bad-orientation')
        orientation = options.orientation as Orientation
      }

      const user = `${session.platform}:${session.userId}`
      if (inFlight.has(user)) return session.text('.busy-user')
      if (config.cooldown > 0) {
        const wait = (lastUse.get(user) ?? 0) + config.cooldown * 1000 - Date.now()
        if (wait > 0) return session.text('.cooldown', [Math.ceil(wait / 1000)])
      }

      inFlight.add(user)
      try {
        const result = await request({ prompt, model, orientation, enhance: config.enhance })
        if ('image_url' in result) {
          lastUse.set(user, Date.now())
          logger.info('image for %s in %dms, balance $%s', user, result.generation_time_ms, Number(result.balance_usd).toFixed(3))
          const image = await toElement(result.image_url)
          return config.showPrompt && result.enhanced_prompt ? [image, h.text(result.enhanced_prompt)] : image
        }

        logger.warn('generation failed: %d %s %s', result.status, result.code, result.message)
        if (result.status === 402) return session.text('.no-balance')
        if (result.status === 401) return session.text('.invalid-key')
        if (result.code === 'MODERATION_BLOCKED' || result.code === 'PROVIDER_REJECTED') return session.text('.rejected', [result.message])
        if (result.status === 503 || result.status === 429) return session.text('.busy')
        return session.text('.failed', [result.message])
      } finally {
        inFlight.delete(user)
      }
    })
}
