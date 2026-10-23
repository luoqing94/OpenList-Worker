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
 * 1) 进程级单例 env 对象引用。
 *
 * EdgeOne Node Functions 请求上下文中 `context.env` 常为 undefined 或每请求新对象，
 * 若原样传给 `app.fetch`，`src/backend/index.ts` 的 `const env = (c.env || {})`
 * 会每次新建 `{}`，导致后端基于 `WeakMap<object, ...>` 的 5 处核心缓存
 * （backend.ts 的 envIds、db.ts 的 dbCache/dbInflight、cache/store.ts 的 resolvedByEnv、
 * json.ts 的 kvBindingCache）全部失效。
 *
 * 这里保持 `sharedEnv` 引用恒定、每次请求就地同步 `process.env` 与 `context.env`，
 * 让同一实例内的所有 WeakMap 缓存稳定命中。
 */
const sharedEnv: Record<string, any> = {
  __makersContext: true,
}

function syncSharedEnv(ctxEnv?: any): Record<string, any> {
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
 *    - 短期缓存 `"openlist_config"`（30s）与 `GET /api/public/settings` 响应（30s），
 *      在 `put` / `delete` 或任何非只读请求时立即同步更新或失效。
 */
const CONFIG_KEY = "openlist_config"
const HEALTH_TTL_MS = 60_000
const CONFIG_BLOB_TTL_MS = 30_000
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

let blobAvailableCached = false
let healthCache: { value: any; ts: number } | null = null
let configBlobCache: { value: string; ts: number } | null = null
let configBlobInflight: Promise<string | null> | null = null
let publicSettingsCache: { body: string; ts: number } | null = null

function invalidateWriteCaches() {
  publicSettingsCache = null
  configBlobCache = null
  configBlobInflight = null
}

const origIsAvailable = blobDriver.isAvailable.bind(blobDriver)
const origHealth = blobDriver.health.bind(blobDriver)
const origGet = blobDriver.get.bind(blobDriver)
const origPut = blobDriver.put.bind(blobDriver)
const origDelete = blobDriver.delete.bind(blobDriver)

function prefetchConfigBlob(env?: any): Promise<string | null> {
  if (configBlobInflight) return configBlobInflight
  const p = origGet(CONFIG_KEY, env)
    .then((val) => {
      if (typeof val === "string" && val.length > 0) {
        configBlobCache = { value: val, ts: Date.now() }
      }
      return val
    })
    .catch(() => null)
    .finally(() => {
      if (configBlobInflight === p) {
        configBlobInflight = null
      }
    })
  configBlobInflight = p
  return p
}

blobDriver.isAvailable = async (env?: any): Promise<boolean> => {
  if (blobAvailableCached) return true
  const ok = await origIsAvailable(env)
  if (ok) blobAvailableCached = true
  return ok
}

blobDriver.health = async (env?: any): Promise<any> => {
  const now = Date.now()
  if (
    !configBlobInflight &&
    (!configBlobCache || now - configBlobCache.ts >= CONFIG_BLOB_TTL_MS)
  ) {
    void prefetchConfigBlob(env)
  }
  if (healthCache && now - healthCache.ts < HEALTH_TTL_MS) {
    return healthCache.value
  }
  const res = await origHealth(env)
  if (res && res.available === true) {
    healthCache = { value: res, ts: Date.now() }
    blobAvailableCached = true
  }
  return res
}

blobDriver.get = async (key: string, env?: any): Promise<string | null> => {
  if (key === CONFIG_KEY) {
    const now = Date.now()
    if (configBlobCache && now - configBlobCache.ts < CONFIG_BLOB_TTL_MS) {
      return configBlobCache.value
    }
    return prefetchConfigBlob(env)
  }
  return origGet(key, env)
}

blobDriver.put = async (key: string, value: string, env?: any): Promise<void> => {
  publicSettingsCache = null
  configBlobInflight = null
  if (key === CONFIG_KEY) {
    configBlobCache = null
  }
  await origPut(key, value, env)
  if (key === CONFIG_KEY && typeof value === "string" && value.length > 0) {
    configBlobCache = { value, ts: Date.now() }
  }
  publicSettingsCache = null
}

blobDriver.delete = async (key: string, env?: any): Promise<void> => {
  publicSettingsCache = null
  configBlobInflight = null
  if (key === CONFIG_KEY) {
    configBlobCache = null
  }
  await origDelete(key, env)
  publicSettingsCache = null
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
    if (publicSettingsCache && now - publicSettingsCache.ts < PUBLIC_SETTINGS_TTL_MS) {
      return new Response(publicSettingsCache.body, {
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
          publicSettingsCache = { body, ts: Date.now() }
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
      publicSettingsCache = null
    }
  }
}

export default onRequest
