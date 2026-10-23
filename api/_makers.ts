/**
 * EdgeOne Makers (Cloud Functions) 统一入口。
 *
 * 构建时由 scripts/build-edge.mjs 打包到 cloud-functions/[[default]].js，
 * 捕获所有路由并交给 Hono 应用处理。同时把 vite 构建产出的 dist/index.html
 * 以文本形式内联进来，作为前端 SPA 路由（/@manage、/@login 等）的回退壳。
 */
import app, { setSpaFallbackHtml } from "../src/backend/index"
import { blobDriver } from "../src/backend/internal/model/store/driver/blob"
import INDEX_HTML from "../dist/index.html"

setSpaFallbackHtml(INDEX_HTML)

/**
 * 1) 进程级单例状态与 env 对象引用（挂载于 globalThis 防止被平台按请求包裹的 IIFE 重置）。
 *
 * EdgeOne Node Functions 请求上下文中 `context.env` 常为 undefined 或每请求新对象，
 * 若原样传给 `app.fetch`，`src/backend/index.ts` 的 `const env = (c.env || {})`
 * 会每次新建 `{}`，导致后端基于 `WeakMap<object, ...>` 的核心缓存
 * （backend.ts 的 envIds、db.ts 的 dbCache/dbInflight、cache/store.ts 的 resolvedByEnv、
 * json.ts 的 kvBindingCache、middlewares.ts 的 jwtSecretByEnv）全部失效。
 *
 * 这里保持 `sharedEnv` 引用恒定、每次请求就地同步 `process.env` 与 `context.env`，
 * 让同一实例内的所有 WeakMap 缓存稳定命中。
 */
interface MakersSingletonState {
  sharedEnv: Record<string, any>
  blobAvailableCached: boolean
  healthCache: { value: any; ts: number } | null
  blobCache: Map<string, { value: string; ts: number }>
  blobInflight: Map<string, Promise<string | null>>
  publicSettingsCache: { body: string; ts: number } | null
  driverWrapped: boolean
}

const STATE_KEY = "__OPENLIST_MAKERS_STATE__"
const state: MakersSingletonState = ((globalThis as any)[STATE_KEY] ||= {
  sharedEnv: { __makersContext: true },
  blobAvailableCached: false,
  healthCache: null,
  blobCache: new Map(),
  blobInflight: new Map(),
  publicSettingsCache: null,
  driverWrapped: false,
})

function syncSharedEnv(ctxEnv?: any): Record<string, any> {
  const sharedEnv = state.sharedEnv
  if (typeof process !== "undefined" && process.env) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) sharedEnv[k] = v
    }
  }
  if (ctxEnv && typeof ctxEnv === "object") {
    for (const [k, v] of Object.entries(ctxEnv)) {
      if (v !== undefined) sharedEnv[k] = v
    }
  }
  sharedEnv.__makersContext = true
  return sharedEnv
}

/**
 * 2) EdgeOne Blob 驱动层透明加速与 `/api/public/settings` L1 缓存（零业务源码侵入）：
 *    - 缓存 `blobDriver.isAvailable` 与 `blobDriver.health`（60s），消除每次 API 请求前
 *      `getStoreConfigErrorDetail` 触发的远程 `edgeOneStore.get("__health_check__")` RTT；
 *    - 冷启动首次 `health()` 时并行预取 `"openlist_config"`，把冷启动的 2 次串行
 *      Blob HTTP 请求折叠为 1 次并行 RTT；
 *    - 短期缓存 Blob 键值读取（30s）与 `GET /api/public/settings` 响应（30s），
 *      在 `put` / `delete` 或任何非只读请求时立即同步更新或失效。
 */
const CONFIG_KEY = "openlist_config"
const HEALTH_TTL_MS = 60_000
const BLOB_CACHE_TTL_MS = 30_000
const PUBLIC_SETTINGS_TTL_MS = 30_000

const READONLY_POST_PATHS = new Set([
  "/api/fs/list",
  "/api/fs/get",
  "/api/fs/dirs",
  "/api/fs/search",
  "/api/fs/other",
  "/api/fs/archive/meta",
  "/api/fs/archive/list",
])

function invalidateWriteCaches() {
  state.publicSettingsCache = null
  state.blobCache.clear()
  state.blobInflight.clear()
}

if (!state.driverWrapped) {
  state.driverWrapped = true

  const origIsAvailable = blobDriver.isAvailable.bind(blobDriver)
  const origHealth = blobDriver.health.bind(blobDriver)
  const origGet = blobDriver.get.bind(blobDriver)
  const origPut = blobDriver.put.bind(blobDriver)
  const origDelete = blobDriver.delete.bind(blobDriver)

  const fetchBlobWithCache = (
    key: string,
    env?: any,
  ): Promise<string | null> => {
    const now = Date.now()
    const cached = state.blobCache.get(key)
    if (cached && now - cached.ts < BLOB_CACHE_TTL_MS) {
      return Promise.resolve(cached.value)
    }
    const inflight = state.blobInflight.get(key)
    if (inflight) return inflight

    const p = origGet(key, env)
      .then((val) => {
        if (typeof val === "string" && val.length > 0) {
          state.blobCache.set(key, { value: val, ts: Date.now() })
        }
        return val
      })
      .catch(() => null)
      .finally(() => {
        if (state.blobInflight.get(key) === p) {
          state.blobInflight.delete(key)
        }
      })
    state.blobInflight.set(key, p)
    return p
  }

  blobDriver.isAvailable = async (env?: any): Promise<boolean> => {
    if (state.blobAvailableCached) return true
    const ok = await origIsAvailable(env)
    if (ok) state.blobAvailableCached = true
    return ok
  }

  blobDriver.health = async (env?: any): Promise<any> => {
    const now = Date.now()
    const cfgCached = state.blobCache.get(CONFIG_KEY)
    if (
      !state.blobInflight.has(CONFIG_KEY) &&
      (!cfgCached || now - cfgCached.ts >= BLOB_CACHE_TTL_MS)
    ) {
      void fetchBlobWithCache(CONFIG_KEY, env)
    }
    if (state.healthCache && now - state.healthCache.ts < HEALTH_TTL_MS) {
      return state.healthCache.value
    }
    const res = await origHealth(env)
    if (res && res.available === true) {
      state.healthCache = { value: res, ts: Date.now() }
      state.blobAvailableCached = true
    }
    return res
  }

  blobDriver.get = async (key: string, env?: any): Promise<string | null> => {
    return fetchBlobWithCache(key, env)
  }

  blobDriver.put = async (
    key: string,
    value: string,
    env?: any,
  ): Promise<void> => {
    state.publicSettingsCache = null
    state.blobInflight.delete(key)
    state.blobCache.delete(key)
    await origPut(key, value, env)
    if (typeof value === "string" && value.length > 0) {
      state.blobCache.set(key, { value, ts: Date.now() })
    }
    state.publicSettingsCache = null
  }

  blobDriver.delete = async (key: string, env?: any): Promise<void> => {
    state.publicSettingsCache = null
    state.blobInflight.delete(key)
    state.blobCache.delete(key)
    await origDelete(key, env)
    state.publicSettingsCache = null
  }
}

export async function onRequest(context: any) {
  const env = syncSharedEnv(context?.env)
  const req: Request = context.request
  const method = (req?.method || "GET").toUpperCase()

  let pathname = ""
  try {
    pathname = new URL(req.url).pathname
  } catch {
    pathname = ""
  }

  if (method === "GET" && pathname === "/api/public/settings") {
    const now = Date.now()
    if (
      state.publicSettingsCache &&
      now - state.publicSettingsCache.ts < PUBLIC_SETTINGS_TTL_MS
    ) {
      return new Response(state.publicSettingsCache.body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "cache-control": "no-cache",
          "x-openlist-l1": "HIT",
        },
      })
    }
    const res = await app.fetch(req, env, context)
    if (
      res.status === 200 &&
      (res.headers.get("content-type") || "").includes("application/json")
    ) {
      try {
        const body = await res.text()
        if (body.includes('"code":200')) {
          state.publicSettingsCache = { body, ts: Date.now() }
        }
        const headers = new Headers(res.headers)
        headers.set("x-openlist-l1", "MISS")
        return new Response(body, { status: res.status, headers })
      } catch {
        return res
      }
    }
    return res
  }

  const isMutating =
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    !READONLY_POST_PATHS.has(pathname)

  if (isMutating) {
    invalidateWriteCaches()
  }

  try {
    return await app.fetch(req, env, context)
  } finally {
    if (isMutating) {
      state.publicSettingsCache = null
    }
  }
}

export default onRequest
