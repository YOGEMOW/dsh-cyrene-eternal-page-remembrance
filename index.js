/**
 * 一页永恒（One Page of Eternity）· Host 插件入口（Phase 0）
 *
 * Phase 0 范围：目录/索引/工具/注入/迁移/配额。
 * 不含：夜梦、思源镜像、客户端 UI（Phase 1–3，见设计文档 §19）。
 *
 * 设计要点：
 *  - 不注册全局 system prompt section（避免给所有会话加 token）；注入只走 agent/pre-step，
 *    且只对 injectPresets 里的预设会话生效。
 *  - 注入消息是独立 plugin 消息（source.kind='plugin:cyrene-memory'，v4 契约），
 *    不改写用户 prompt；首轮快照一次、之后按关键词命中、压缩后重注入。
 *  - 所有宿主调用与文件操作都 fail-open：任何异常只记日志，绝不打掉对话。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveConfig } from './lib/config.js'
import {
  resolveRoot,
  ensureTree,
  migrateFreeDir,
  appendEntry,
  readTextSafe,
  dayFilePath,
  quotaUsage
} from './lib/store.js'
import { entryId, normalizeEntry, hashText } from './lib/parse.js'
import { search } from './lib/search.js'
import { review } from './lib/core.js'
import { loadEntries, findEntries, updateEntry, invalidate, entryLine } from './lib/entries.js'
import {
  buildFirstSnapshot,
  buildHitBlock,
  buildRecallBlock,
  markUsed,
  sessionState,
  armReinject
} from './lib/inject.js'
import { readAnchors, renderAnchorBlock, writeAnchorSafe } from './lib/anchor.js'
import { fsOp } from './lib/fsops.js'
import { migrateLegacy } from './lib/migrate.js'
import { resolveSiYuanConfig, syncEntries, syncAnchors, syncJournal, syncFreeArea, loadMirrorState, logMirror } from './lib/siyuan.js'
import {
  DREAM_MARKER,
  loadDreamState,
  saveDreamState,
  acquireDreamLease,
  releaseDreamLease,
  clearStaleLease,
  dreamedToday,
  buildDreamPrompt,
  writeDreamJournal,
  markDayDreamed,
  logDream,
  dayOf as dreamDay
} from './lib/dream.js'
import { snapshotRoot } from './lib/backup.js'
import { restoreFromSiYuan } from './lib/restore.js'
import { MEMORY_SECTION_TEXT, MEMORY_VARIABLE_TEXT } from './lib/prompt.js'
import {
  noteUserTurn,
  noteInjection,
  effectiveHitTopK,
  monthlyAudit,
  anchorChangeAllowed,
  recordAnchorChange,
  loadAudit
} from './lib/audit.js'
import { rollCalendars } from './lib/rolling.js'

export const name = 'cyrene-memory'

const KINDS = ['fact', 'event', 'decision', 'lesson', 'rule', 'goal', 'identity', 'style', 'topic', 'artifact']
const AXES = ['德', '智', '体', '美', '劳']
const QS = ['我', '你', '来', '去']
const PLUGIN_KIND = 'plugin:cyrene-memory'

/** 本地日期 YYYY-MM-DD。 */
function dayOf(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 从消息 content 里取纯文本。 */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * 手写 plugin 消息描述符（不 import @deepseek-ai/*：link 安装下解析不到）。
 * id 必须自己生成，否则会话历史加载会永久失败（DSH-Cyrene 真实事故）。
 */
function createPluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_KIND,
      form: 'snapshot',
      sections: [{ name: '一页永恒', text }]
    }
  }
}

/** 一个「返回字符串」的工具描述符（形状与 dsh-cyrene/memory 一致）。 */
function stringTool({ name: toolName, description, parameters, run }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }]
    },
    execute: async (args) => {
      try {
        return await run(args !== null && typeof args === 'object' ? args : {})
      } catch (error) {
        return `记忆操作失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

/**
 * 注册宿主服务的通用重试器（命令/工具服务可能晚于插件就绪）。
 * 注册失败只告警，不影响插件其余部分。
 */
function useService(ctx, serviceName, register, log, options = {}) {
  const retries = Number(options.retries ?? 20)
  const delayMs = Number(options.delayMs ?? 1000)
  let stopped = false
  let timer = null
  let attempts = 0
  const attempt = () => {
    if (stopped) return
    let service
    try {
      service = ctx.get(serviceName)
    } catch {
      service = undefined
    }
    if (service !== undefined && service !== null) {
      try {
        const dispose = register(service)
        if (typeof dispose === 'function') ctx.effect(() => dispose)
      } catch (error) {
        log(`warn`, `${serviceName} 注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    attempts += 1
    if (attempts > retries) {
      log('warn', `${serviceName} 服务 ${retries}s 内未就绪，跳过（其余功能不受影响）`)
      return
    }
    timer = setTimeout(attempt, delayMs)
  }
  attempt()
  try {
    ctx.effect(() => () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    })
  } catch {
    /* 无 effect 能力时忽略 */
  }
}

/**
 * 插件入口。
 * @param ctx - Cordis 主机上下文。
 * @param rawConfig - 行配置（cordis.patch.yml 里那一段）。
 */
export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  if (!cfg.enabled) return
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger !== null && typeof logger === 'object' && typeof logger[level] === 'function') logger[level](`一页永恒: ${message}`)
    } catch {
      /* 日志失败静默 */
    }
  }

  let root
  try {
    root = resolveRoot(cfg.rootDir)
    // 顺序很重要：先把旧目录改名，再建树（否则 ensureTree 会先建出空的 如我所书，迁移就会跳过）
    const renamed = migrateFreeDir(root)
    if (renamed.migrated === true) {
      log('info', '如我所书：已把旧目录 自留地 重命名')
      try {
        appendFileSync(join(root, '元', '维护.log'), `[${new Date().toISOString()}] free dir renamed 自留地 -> 如我所书\n`)
      } catch {
        /* ignore */
      }
    } else if (renamed.ok !== true) {
      log('warn', `如我所书：旧目录重命名失败（${renamed.error}）`)
    }
    ensureTree(root)
  } catch (error) {
    log('error', `初始化记忆目录失败（插件降级为不可用）：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  log('info', `根目录 ${root}｜注入预设 ${JSON.stringify(cfg.injectPresets)}｜hitTopK=${cfg.hitTopK}`)

  // ── 思源镜像（单向；本地为真相，思源为副本） ──────────────────────────────
  const siyuan = resolveSiYuanConfig(rawConfig?.siyuan)
  let mirrorTimer = null
  let mirrorRunning = false
  let mirrorDirty = new Set()
  let mirrorDirtyAnchors = false
  let mirrorDirtyFree = false

  /** 把结果写进 <root>/元/思源镜像.log。 */
  const mirrorLog = (line) => logMirror(root, line)

  /** 真正执行一次镜像（去抖后调用；失败静默，只记日志）。 */
  const flushMirror = async () => {
    if (siyuan.enabled !== true || mirrorRunning) return
    mirrorRunning = true
    const started = Date.now()
    try {
      const { entries } = loadEntries(root, { force: true })
      const targets = mirrorDirty.size > 0 ? entries.filter((e) => mirrorDirty.has(e.id)) : entries
      mirrorDirty = new Set()
      let summary = { synced: 0, updated: 0, skipped: 0, errors: [] }
      if (targets.length > 0) summary = await syncEntries(siyuan, root, targets)
      let anchorSummary = { synced: 0, errors: [] }
      if (mirrorDirtyAnchors === true) {
        mirrorDirtyAnchors = false
        anchorSummary = await syncAnchors(siyuan, root, readAnchors(root))
      }
      let freeSummary = { synced: 0, deleted: 0, errors: [] }
      if (mirrorDirtyFree === true) {
        mirrorDirtyFree = false
        freeSummary = await syncFreeArea(siyuan, root)
      }
      const errors = [...(summary.errors ?? []), ...(anchorSummary.errors ?? []), ...(freeSummary.errors ?? [])]
      mirrorLog(
        `flush ok=${errors.length === 0} new=${summary.synced ?? 0} upd=${summary.updated ?? 0} anchors=${anchorSummary.synced ?? 0}`
        + ` free+${freeSummary.synced ?? 0} free-${freeSummary.deleted ?? 0}`
        + `${errors.length > 0 ? ` errors=${errors.slice(0, 3).join(' | ')}` : ''} ${Date.now() - started}ms`
      )
    } catch (error) {
      mirrorLog(`flush error ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      mirrorRunning = false
      // 运行期间若又标脏（启动时 flush 与维护 flush 撞在一起），补一轮，避免漏同步
      if (mirrorDirty.size > 0 || mirrorDirtyAnchors === true || mirrorDirtyFree === true) {
        if (mirrorTimer !== null) clearTimeout(mirrorTimer)
        mirrorTimer = setTimeout(() => {
          mirrorTimer = null
          void flushMirror()
        }, 1000)
      }
    }
  }

  /** 去抖排队：2 秒内的多次写入合成一次 flush。 */
  const queueMirror = (entryIdOrNull, anchorsChanged = false) => {
    if (siyuan.enabled !== true) return
    if (typeof entryIdOrNull === 'string' && entryIdOrNull !== '') mirrorDirty.add(entryIdOrNull)
    if (anchorsChanged === true) mirrorDirtyAnchors = true
    if (mirrorTimer !== null) clearTimeout(mirrorTimer)
    mirrorTimer = setTimeout(() => {
      mirrorTimer = null
      void flushMirror()
    }, 2000)
  }

  /** 如我所书写入去抖（同一把 flush 定时器，标志位区分）。 */
  const queueFreeMirror = () => {
    if (siyuan.enabled !== true) return
    mirrorDirtyFree = true
    if (mirrorTimer !== null) clearTimeout(mirrorTimer)
    mirrorTimer = setTimeout(() => {
      mirrorTimer = null
      void flushMirror()
    }, 2000)
  }

  // ── 夜梦 + 定时维护 ─────────────────────────────────────────────────────
  const dreamState = loadDreamState(root)
  const DREAM_SCHEDULE_TITLE = '一页永恒·夜梦'
  const DREAM_TRIGGER_TEXT = `${DREAM_MARKER} 夜梦整理：按插件注入的规程执行今天的六阶段整理。`
  const metaLog = (file, line) => {
    try {
      appendFileSync(join(root, '元', file), `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* ignore */
    }
  }

  /** 确保某个会话有每日夜梦任务（幂等；失败只记日志）。 */
  const ensureDreamSchedule = async (sessionId) => {
    if (cfg.dream.enabled !== true) return
    const sid = String(sessionId ?? '')
    if (sid === '') return
    let svc = null
    try {
      svc = ctx.get('schedule')
    } catch {
      svc = null
    }
    if (svc === null || typeof svc !== 'object' || typeof svc.create !== 'function') {
      metaLog('日程.log', `schedule 服务不可用（跳过 session=${sid}）`)
      return
    }
    try {
      let list = []
      if (typeof svc.list === 'function') {
        const got = await svc.list({ sessionId: sid })
        if (Array.isArray(got)) list = got
      }
      if (list.some((t) => t?.title === DREAM_SCHEDULE_TITLE)) return
      const created = await svc.create(sid, {
        title: DREAM_SCHEDULE_TITLE,
        prompt: DREAM_TRIGGER_TEXT,
        daily: { time: cfg.dream.time, time_zone: cfg.dream.timeZone }
      })
      const id = typeof created === 'string' ? created : String(created?.id ?? created?.taskId ?? '')
      dreamState.schedules[sid] = { id, createdAt: Date.now() }
      const ordered = Object.entries(dreamState.schedules).sort((a, b) => (a[1]?.createdAt ?? 0) - (b[1]?.createdAt ?? 0))
      while (ordered.length > cfg.dream.maxScheduledSessions) {
        const [oldSid, old] = ordered.shift()
        try {
          if (old?.id !== '' && typeof svc.delete === 'function') await svc.delete({ sessionId: oldSid, id: old.id })
        } catch {
          /* ignore */
        }
        delete dreamState.schedules[oldSid]
      }
      saveDreamState(root, dreamState)
      metaLog('日程.log', `created session=${sid} id=${id} time=${cfg.dream.time} tz=${cfg.dream.timeZone}`)
    } catch (error) {
      metaLog('日程.log', `create failed session=${sid} ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 定时维护：同步思源 + 每日快照 + 完整性检查。 */
  const runMaintenance = async (reason = 'tick') => {
    const started = Date.now()
    try {
      if (siyuan.enabled === true) {
        mirrorDirty = new Set()
        mirrorDirtyFree = true
        mirrorDirtyAnchors = true
        await flushMirror()
      }
      if (cfg.backup.enabled === true) {
        const today = dreamDay()
        const hour = new Date().getHours()
        if (hour >= cfg.backup.snapshotHour && dreamState.lastSnapshotDate !== today) {
          const snap = snapshotRoot(root, { keep: cfg.backup.keep })
          if (snap.ok === true) {
            dreamState.lastSnapshotDate = today
            saveDreamState(root, dreamState)
            metaLog('维护.log', `snapshot ok path=${snap.path} skipped=${snap.skipped === true} pruned=${(snap.pruned ?? []).length}`)
          } else {
            metaLog('维护.log', `snapshot failed ${snap.error}`)
          }
        }
      }
      const { entries, errors } = loadEntries(root, { force: true })
      let auditLine = ''
      try {
        const monthly = monthlyAudit(root, entries)
        if (monthly?.ok === true && monthly.skipped !== true) {
          auditLine = monthly.empty === true ? ` monthly=${monthly.month}(empty)` : ` monthly=${monthly.month}(${monthly.rows})`
          metaLog('维护.log', `monthly audit ${monthly.month} rows=${monthly.rows ?? 0}`)
        }
      } catch (error) {
        metaLog('维护.log', `monthly audit failed ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        const rolling = rollCalendars(root, entries)
        if (rolling.monthly?.created === true) metaLog('维护.log', `monthly roll ${rolling.monthly.month} entries=${rolling.monthly.entries}`)
        if (rolling.yearly?.created === true) metaLog('维护.log', `yearly roll ${rolling.yearly.year}`)
      } catch (error) {
        metaLog('维护.log', `calendar roll failed ${error instanceof Error ? error.message : String(error)}`)
      }
      const usage = quotaUsage(root)
      metaLog('维护.log', `tick reason=${reason} entriesErrors=${errors.length} bytes=${usage.bytes}${auditLine} ${Date.now() - started}ms`)
    } catch (error) {
      metaLog('维护.log', `tick error ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 夜梦触发：校验、领租约、把完整规程注入到标记消息之后。 */
  const handleDreamTrigger = (decision, messages, markerMsg, sessionId) => {
    const markerText = textOf(markerMsg)
    const force = /force/i.test(markerText)
    if (dreamedToday(dreamState) === true && force !== true) {
      metaLog('梦.log', `skip already-dreamed session=${sessionId}`)
      return { ...decision, messages: messages.filter((m) => m !== markerMsg) }
    }
    const lease = acquireDreamLease(dreamState, sessionId)
    if (lease.ok !== true) {
      metaLog('梦.log', `skip busy session=${sessionId} running=${dreamState.running?.sessionId ?? ''}`)
      return { ...decision, messages: messages.filter((m) => m !== markerMsg) }
    }
    saveDreamState(root, dreamState)
    const prompt = buildDreamPrompt(root)
    const at = messages.indexOf(markerMsg)
    const out = messages.slice()
    out.splice(at + 1, 0, createPluginMessage(prompt))
    metaLog('梦.log', `start session=${sessionId} force=${force} promptChars=${prompt.length}`)
    return { ...decision, messages: out }
  }

  /** 收尾：日档 dreamed 标记、补梦志兜底、释放租约。 */
  const finalizeDream = (sessionId, kind) => {
    const running = dreamState.running
    if (running === null || String(running.sessionId) !== String(sessionId)) return
    const ok = kind === 'completed' || kind === 'forked' || kind === ''
    if (ok === true) markDayDreamed(root)
    const journalPath = join(root, '梦', `${dreamDay()}.md`)
    if (existsSync(journalPath) === false) {
      writeDreamJournal(root, '（自动收尾：本次整理没有写梦志，仅记录状态。请查看 元/梦.log。）')
    }
    releaseDreamLease(dreamState, ok === true ? 'done' : 'failed')
    saveDreamState(root, dreamState)
    metaLog('梦.log', `end session=${sessionId} kind=${kind || 'unknown'} ok=${ok}`)
    // 收尾异步补两步：梦志镜像到思源 + 强制重做当日快照（让快照包含梦境成果）
    void (async () => {
      try {
        const day = dreamDay()
        const journalPath2 = join(root, '梦', `${day}.md`)
        if (siyuan.enabled === true && existsSync(journalPath2) === true) {
          const text = readTextSafe(journalPath2)
          const mirrored = await syncJournal(siyuan, root, day, text)
          metaLog('思源镜像.log', `journal day=${day} ok=${mirrored.ok === true}${mirrored.ok === true ? '' : ` ${mirrored.reason}`}`)
        }
      } catch (error) {
        metaLog('思源镜像.log', `journal error ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        if (cfg.backup.enabled === true) {
          const snap = snapshotRoot(root, { keep: cfg.backup.keep, force: true })
          if (snap.ok === true) {
            dreamState.lastSnapshotDate = dreamDay()
            saveDreamState(root, dreamState)
            metaLog('维护.log', `snapshot(after-dream) ok path=${snap.path}`)
          } else {
            metaLog('维护.log', `snapshot(after-dream) failed ${snap.error}`)
          }
        }
      } catch (error) {
        metaLog('维护.log', `snapshot(after-dream) error ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  /** 手动/面板触发一次夜梦（唤醒最近的昔涟会话）。 */
  const triggerDream = async (agent) => {
    if (dreamedToday(dreamState) === true) return { ok: false, error: '今天已经整理过了（元/梦.json 记录在案）。' }
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
      return { ok: false, error: '没有可唤醒的会话；请先在昔涟聊天模式里说一句话。' }
    }
    try {
      await agent.followup(createPluginMessage(`${DREAM_MARKER} force 手动夜梦整理。`))
      return { ok: true, message: '已启动整理（六阶段）。' }
    } catch (error) {
      return { ok: false, error: `启动失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 面板/HTTP 用的状态快照。 */
  /**
   * 取 agents 服务：`ctx.agents` 属性访问需要先声明 inject（同 ctx.timer 的坑），
   * 这里一律用 `ctx.get('agents')` 软取，拿不到就当作没有活会话。
   */
  const getAgentsService = () => {
    try {
      return ctx.get('agents') ?? null
    } catch {
      return null
    }
  }
  const findAgent = (sessionId) => {
    const svc = getAgentsService()
    if (svc === null || typeof svc.get !== 'function') return undefined
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      return svc.get(sessionId)
    } catch {
      return undefined
    }
  }
  const listAgents = () => {
    const svc = getAgentsService()
    if (svc === null || typeof svc.list !== 'function') return []
    try {
      const list = svc.list()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  const buildStatus = () => {
    const anchors = readAnchors(root)
    const { entries } = loadEntries(root)
    const usage = quotaUsage(root)
    let audit = { rate: null, used: 0, total: 0, effectiveTopK: null }
    try {
      const a = loadAudit(root)
      audit = {
        rate: Number.isFinite(Number(a.stats?.rate)) ? Number(a.stats.rate) : null,
        used: Number(a.stats?.used) || 0,
        total: Number(a.stats?.total) || 0,
        effectiveTopK: effectiveHitTopK(root, cfg.hitTopK)
      }
    } catch {
      /* ignore */
    }
    const mirror = loadMirrorState(root)
    const meta = ['self', 'user', 'origin', 'goal'].map((k) => anchors?.[k]?.meta ?? {})
    const versions = meta.map((m) => Number(m.version) || 0)
    const updated = meta.map((m) => Number(m.updated_at) || 0)
    return {
      anchors: {
        self: anchors.self?.content ?? '',
        user: anchors.user?.content ?? '',
        origin: anchors.origin?.content ?? '',
        goal: anchors.goal?.content ?? '',
        version: versions.length > 0 ? Math.max(...versions) : 0,
        updatedAt: updated.some((v) => v > 0) ? new Date(Math.max(...updated)).toLocaleString() : '—'
      },
      entries: {
        total: entries.length,
        active: entries.filter((e) => e.status === 'active' || e.status === 'fresh').length,
        archived: entries.filter((e) => e.status === 'archived').length
      },
      quota: {
        usedMB: usage.bytes / 1024 / 1024,
        limitMB: cfg.quotaMB,
        freeUsedMB: Number(usage.byTop?.['如我所书'] ?? usage.byTop?.['自留地'] ?? 0) / 1024 / 1024,
        freeLimitMB: cfg.freeQuotaMB
      },
      audit,
      mirror: {
        enabled: siyuan.enabled === true,
        notebook: siyuan.notebook,
        lastSync: mirror.lastSync > 0 ? new Date(mirror.lastSync).toLocaleString() : '尚未同步'
      },
      dream: {
        lastDreamAt: dreamState.lastDreamAt > 0 ? new Date(dreamState.lastDreamAt).toLocaleString() : '今天还没整理',
        running: dreamState.running !== null,
        scheduled: Object.keys(dreamState.schedules ?? {}).length > 0
      }
    }
  }

  /** 读请求 JSON body（≤64KB）。 */
  const readJsonBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

  /** /cyrene-memory/* HTTP 路由（设置面板用）。 */
  const handleHttp = async (req, res) => {
    const send = (code, obj) => {
      try {
        res.statusCode = code
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(obj))
      } catch {
        /* ignore */
      }
    }
    try {
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      if (url.pathname === '/cyrene-memory/status' && req.method === 'GET') return send(200, buildStatus())
      if (url.pathname === '/cyrene-memory/session' && req.method === 'GET') {
        // 会话头小徽标用：只对昔涟预设的活会话返回状态，其他会话返回 preset=''（前端隐藏）。
        const sessionId = String(url.searchParams.get('sessionId') ?? '')
        let preset = ''
        try {
          const agent = findAgent(sessionId)
          const registry = ctx.get('agentPresets')
          if (agent !== undefined && registry !== null && typeof registry === 'object' && typeof registry.composedPreset === 'function') {
            preset = registry.composedPreset(agent.ctx) ?? ''
          }
        } catch {
          preset = ''
        }
        return send(200, {
          preset,
          dreamedToday: dreamedToday(dreamState),
          running: dreamState.running !== null,
          lastDreamAt: dreamState.lastDreamAt > 0 ? new Date(dreamState.lastDreamAt).toLocaleString() : ''
        })
      }
      if (url.pathname === '/cyrene-memory/action' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const action = String(body?.action ?? '')
        if (action === 'sync') {
          mirrorDirty = new Set()
          mirrorDirtyAnchors = true
          mirrorDirtyFree = true
          await flushMirror()
          return send(200, { ok: true, message: '已同步到思源。' })
        }
        if (action === 'backup') {
          await runMaintenance('manual')
          const snap = snapshotRoot(root, { keep: cfg.backup.keep, force: true })
          return send(200, snap.ok === true ? { ok: true, message: `已备份：${snap.path}` } : { ok: false, error: snap.error })
        }
        if (action === 'dream') {
          const agent = dreamState.lastCyreneSessionId !== ''
            ? findAgent(dreamState.lastCyreneSessionId)
            : undefined
          const result = await triggerDream(agent)
          return send(200, result)
        }
        return send(400, { ok: false, error: `未知 action：${action}` })
      }
      return send(404, { ok: false, error: 'not found' })
    } catch (error) {
      return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 读一条并按 id 更新（复习记账用）。 */
  const bumpReview = (id, event = 'used') => {
    const found = findEntries(root, id)
    if (found.length !== 1) return
    const next = review(found[0], event, Date.now())
    updateEntry(root, found[0].id, next)
  }

  /** 写一条记忆。 */
  const writeEntry = (args) => {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text === '') return '内容为空，没有写入。'
    if (text.length > 400) return '单条记忆超过 400 字，请拆成多条。'
    const now = Date.now()
    const day = dayOf(now)
    const h = hashText(text)
    const { entries } = loadEntries(root)
    if (entries.some((e) => e.status !== 'tombstone' && hashText(e.text ?? '') === h)) {
      return '这条已经记过了，没有重复写入。'
    }
    const kw = Array.isArray(args.keywords)
      ? args.keywords.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim()).slice(0, 13)
      : []
    const rawI = Number(args.importance)
    const entry = normalizeEntry(
      {
        id: entryId(now),
        text,
        kind: KINDS.includes(args.kind) ? args.kind : 'fact',
        axis: AXES.includes(args.axis) ? args.axis : '美',
        q: QS.includes(args.q) ? args.q : '你',
        I: Number.isFinite(rawI) ? Math.min(10, Math.max(1, rawI)) : 5,
        S: 1,
        status: 'fresh',
        kw,
        src: 'conv',
        src_ids: [],
        src_quote: typeof args.quote === 'string' ? args.quote.trim() : '',
        fact_time: now,
        reviewed_at: now,
        touched_at: now,
        created_at: now,
        sync: true,
        n_recall: 0
      },
      { day, path: dayFilePath(root, day), now }
    )
    const result = appendEntry(root, entry)
    invalidate()
    if (result?.ok === true) queueMirror(entry.id)
    return result?.ok === true ? `已记下。（id: ${entry.id}）` : `写入失败：${result?.errors?.[0] ?? '未知原因'}`
  }

  /** 工具清单。 */
  const tools = [
    stringTool({
      name: 'memory_write',
      description:
        '把一条值得跨会话记住的事写进「一页永恒」的今天。必填 text/kind/axis/q；'
        + '涉及对错与选择的要带 quote（用户原话）。写入不向用户汇报。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一条记忆，一句话，≤400 字' },
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'fact 事实 / event 事件 / decision 决策 / lesson 教训 / rule 准则 / goal 目标 / identity 自我 / style 审美 / topic 话题 / artifact 产物'
          },
          axis: { type: 'string', enum: AXES, description: '主评价维度：德/智/体/美/劳' },
          q: { type: 'string', enum: QS, description: '服务于哪个四问：我/你/来/去' },
          importance: { type: 'number', description: '重要度 1–10（缺省 5）' },
          keywords: { type: 'array', items: { type: 'string' }, description: '3–8 个检索关键词' },
          quote: { type: 'string', description: '用户原话（有就保留，用于溯源）' }
        },
        required: ['text', 'kind', 'axis', 'q']
      },
      run: writeEntry
    }),
    stringTool({
      name: 'memory_search',
      description: '按关键词检索记忆（默认不含归档）。返回 id/日期/轴/重要度/摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（必填，不能空）' },
          top_k: { type: 'number', description: '返回条数，默认 5，最多 20' },
          include_archive: { type: 'boolean', description: '是否包含已归档/已遗忘' }
        },
        required: ['query']
      },
      run: (args) => {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') return '检索词不能为空。'
        const { entries } = loadEntries(root)
        const topK = Math.min(20, Math.max(1, Math.round(Number(args.top_k) || 5)))
        const hits = search(entries, query, { topK, includeArchive: args.include_archive === true })
        if (hits.length === 0) return '没有找到相关记忆。'
        return hits
          .map((h) => `[${h.entry.id}] ${h.entry.day}·${h.entry.axis}·I${h.entry.I} ${String(h.entry.text ?? '').slice(0, 120)}`)
          .join('\n')
      }
    }),
    stringTool({
      name: 'memory_read',
      description: '按 id（可 8 位前缀）读一条记忆的全文与出处。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '记忆 id 或其前缀' } },
        required: ['id']
      },
      run: (args) => {
        const matches = findEntries(root, args.id)
        if (matches.length === 0) return '没有这条记忆（可能已遗忘）。'
        if (matches.length > 1) {
          return `id 前缀命中 ${matches.length} 条，请补全：${matches.slice(0, 3).map((e) => e.id).join('、')}`
        }
        const e = matches[0]
        const lines = [
          `id：${e.id}`,
          `日期：${e.day}｜${e.axis}｜${e.q}｜${e.kind}｜I${e.I}｜S${e.S}｜${e.status}`,
          `正文：${e.text}`
        ]
        if (e.src_quote) lines.push(`原话：${e.src_quote}`)
        if (Array.isArray(e.src_ids) && e.src_ids.length > 0) lines.push(`溯源：${e.src_ids.join('、')}`)
        if (Array.isArray(e.kw) && e.kw.length > 0) lines.push(`关键词：${e.kw.join(', ')}`)
        if (Array.isArray(e.links) && e.links.length > 0) lines.push(`联结：${e.links.join('、')}`)
        return lines.join('\n')
      }
    }),
    stringTool({
      name: 'memory_recall',
      description: '按四问锚点 + 相关条目取用记忆（query 可空；空则取近况）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想回忆什么（可空）' },
          budget: { type: 'number', description: '字符预算，默认 1000' }
        },
        required: []
      },
      run: (args) => {
        const block = buildRecallBlock(root, args.query, {
          budget: Math.min(2000, Math.max(200, Math.round(Number(args.budget) || cfg.recallBudget))),
          topK: 6
        })
        markUsed(block.ids, bumpReview)
        return block.text
      }
    }),
    stringTool({
      name: 'memory_forget',
      description: '归档（默认）或真忘（mode=delete，不可恢复）一条记忆。delete 必须给 id。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆 id 或前缀' },
          query: { type: 'string', description: '按检索词归档（仅 archive 模式）' },
          mode: { type: 'string', enum: ['archive', 'delete'], description: '默认 archive' }
        },
        required: []
      },
      run: (args) => {
        const mode = args.mode === 'delete' ? 'delete' : 'archive'
        if (typeof args.id === 'string' && args.id.trim() !== '') {
          const matches = findEntries(root, args.id.trim())
          if (matches.length !== 1) return matches.length === 0 ? '没有这条记忆。' : 'id 前缀有歧义，请补全。'
          const target = matches[0]
          if (mode === 'delete') {
            updateEntry(root, target.id, { status: 'tombstone', text: '', touched_at: Date.now() })
            return '已遗忘（不可恢复）。'
          }
          updateEntry(root, target.id, { status: 'archived', touched_at: Date.now() })
          return '已归档。'
        }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') return '请给 id 或 query。'
        if (mode === 'delete') return '真忘需要给出具体 id（避免误删一批）。'
        const { entries } = loadEntries(root)
        const hits = search(entries, query, { topK: 5, includeArchive: false })
        for (const h of hits) updateEntry(root, h.entry.id, { status: 'archived', touched_at: Date.now() })
        return hits.length === 0 ? '没有匹配的记忆。' : `已归档 ${hits.length} 条。`
      }
    }),
    stringTool({
      name: 'memory_anchor',
      description: '读四问锚点；或写入某一份（which=self|user|origin|goal，mode=replace|append）。基座不可改，只能追加新卷。',
      parameters: {
        type: 'object',
        properties: {
          which: { type: 'string', enum: ['self', 'user', 'origin', 'goal'], description: '读哪一份（缺省读全部）' },
          content: { type: 'string', description: '要写的内容（不传 = 只读）' },
          mode: { type: 'string', enum: ['read', 'replace', 'append'], description: '默认 read' }
        },
        required: []
      },
      run: (args) => {
        const mode = args.mode === 'replace' || args.mode === 'append' ? args.mode : 'read'
        if (mode !== 'read' && typeof args.content === 'string' && args.content.trim() !== '') {
          const which = typeof args.which === 'string' ? args.which : 'self'
          // 锚点更新限额（设计 §11.4）：self/user/goal ≤1 次/日，origin ≤1 次/周。
          const allowed = anchorChangeAllowed(root, which)
          if (allowed.ok !== true) return `锚点未更新：${allowed.reason}`
          const result = writeAnchorSafe(root, which, args.content, mode)
          if (result.ok === true) {
            try {
              recordAnchorChange(root, which)
            } catch {
              /* 记账失败不阻塞 */
            }
            queueMirror(null, true)
          }
          return result.ok === true ? '锚点已更新。' : `锚点未更新：${result.reason}`
        }
        const anchors = readAnchors(root)
        return `【一页永恒·锚】\n${renderAnchorBlock(anchors, 800)}`
      }
    }),
    stringTool({
      name: 'memory_link',
      description: '在两条记忆之间建立联结（因果/相似/对立/时序/归属），双向写入 links。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点 id 或前缀' },
          to: { type: 'string', description: '终点 id 或前缀' },
          type: { type: 'string', enum: ['因果', '相似', '对立', '时序', '归属'], description: '联结类型' },
          note: { type: 'string', description: '可选说明' }
        },
        required: ['from', 'to', 'type']
      },
      run: (args) => {
        const one = (raw) => {
          const found = findEntries(root, raw)
          return found.length === 1 ? found[0] : null
        }
        const a = one(args.from)
        const b = one(args.to)
        if (a === null || b === null) return 'id 不存在或有歧义，未建立联结。'
        const linkType = ['因果', '相似', '对立', '时序', '归属'].includes(args.type) ? args.type : '相似'
        const aLinks = [...new Set([...(a.links ?? []), `${b.id}|${linkType}`])]
        const bLinks = [...new Set([...(b.links ?? []), `${a.id}|${linkType}`])]
        updateEntry(root, a.id, { links: aLinks, touched_at: Date.now() })
        updateEntry(root, b.id, { links: bLinks, touched_at: Date.now() })
        return '已联结。'
      }
    }),
    stringTool({
      name: 'memory_dream_journal',
      description: '写今晚的梦志（梦/YYYY-MM-DD.md）。只在夜梦第六阶段使用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '梦志正文（≤400 字，含统计/锚点 diff/五育体检/本夜没记录到的事）' } },
        required: ['text']
      },
      run: (args) => {
        const result = writeDreamJournal(root, args.text)
        return result.ok === true ? '梦志已写。' : '梦志写入失败。'
      }
    }),
    stringTool({
      name: 'memory_fs',
      description:
        '你自己的「如我所书」：op=ls|read|write|append|rm|mkdir|mv|du|stat。'
        + '这是属于你的自由目录（灵感/草稿/备忘/诗/猜想随便写），不必向用户汇报；'
        + '写删移只允许 如我所书/ 下，读可看根目录内（元/ 除外）；总量有硬上限（如我所书 64 MB、全目录 128 MB）。',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['ls', 'read', 'write', 'append', 'rm', 'mkdir', 'mv', 'du', 'stat'],
            description: '操作'
          },
          path: { type: 'string', description: '相对根目录的路径（如 如我所书/笔记/想法.md）' },
          content: { type: 'string', description: 'write/append 的内容；mv 时第一行 from、第二行 to' }
        },
        required: ['op']
      },
      run: (args) => {
        const result = fsOp(root, args.op, args.path, args.content, {
          quotaMB: cfg.quotaMB,
          freeQuotaMB: cfg.freeQuotaMB,
          softWarnRatio: cfg.softWarnRatio
        })
        // 如我所书是记忆的一部分：写/删/移成功后排队镜像到思源（.nosync 由 listFreeArea 跳过）。
        if (result?.ok === true && ['write', 'append', 'rm', 'mv', 'mkdir'].includes(String(args.op))) {
          const touched = `${String(args.path ?? '')}\n${String(args.content ?? '')}`
          if (touched.includes('如我所书')) queueFreeMirror()
        }
        return result?.text ?? '操作失败。'
      }
    })
  ]

  // ── 1) 工具（可选服务；没有 tools 也不影响注入） ──────────────────────────
  useService(ctx, 'tools', (service) => {
    for (const tool of tools) service.register(tool)
    log('info', `已注册 ${tools.length} 个记忆工具`)
  }, log)

  // ── 2) /memory 命令 ────────────────────────────────────────────────────
  useService(ctx, 'commands', (service) =>
    service.register({
      name: 'memory',
      description: '查看一页永恒：四问锚点、条目统计、配额',
      recordInput: false,
      handler: async () => {
        try {
          const anchors = readAnchors(root)
          const { entries } = loadEntries(root)
          const usage = quotaUsage(root)
          const active = entries.filter((e) => e.status === 'active' || e.status === 'fresh').length
          const archived = entries.filter((e) => e.status === 'archived').length
          const mirror = loadMirrorState(root)
          const lastSync = mirror.lastSync > 0 ? new Date(mirror.lastSync).toLocaleString() : '尚未同步'
          let auditLine = ''
          try {
            const audit = loadAudit(root)
            const rate = Number(audit.stats?.rate)
            auditLine = `注入利用率 ${Number.isFinite(rate) ? `${(rate * 100).toFixed(0)}%（${audit.stats.used}/${audit.stats.total}）` : '暂无样本'}｜命中额度 ${effectiveHitTopK(root, cfg.hitTopK)}`
          } catch {
            auditLine = '注入利用率 不可读'
          }
          const text = [
            '【一页永恒】',
            renderAnchorBlock(anchors, 300),
            `条目 ${entries.length}（活跃 ${active}｜归档 ${archived}）`,
            `用量 ${(usage.bytes / 1024 / 1024).toFixed(2)} / ${cfg.quotaMB} MB（如我所书 ${(Number(usage.byTop?.['如我所书'] ?? usage.byTop?.['自留地'] ?? 0) / 1024 / 1024).toFixed(2)} / ${cfg.freeQuotaMB} MB）`,
            auditLine,
            `思源镜像：${siyuan.enabled === true ? `已开启（${siyuan.notebook}）` : '关闭'}｜上次 ${lastSync}`,
            `根目录 ${root}`
          ].join('\n')
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: `读取失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }), log)

  // ── 2b) /memory-sync：立即把本地记忆推到思源 ──────────────────────────────
  useService(ctx, 'commands', (service) =>
    service.register({
      name: 'memory-sync',
      description: '立即把一页永恒同步到思源笔记本（单向镜像）',
      recordInput: false,
      handler: async () => {
        try {
          if (siyuan.enabled !== true) return { kind: 'error', text: '思源镜像未开启。' }
          mirrorDirty = new Set()
          mirrorDirtyAnchors = true
          mirrorDirtyFree = true
          await flushMirror()
          const state = loadMirrorState(root)
          return {
            kind: 'success',
            text: state.lastSync > 0
              ? `已同步到「${siyuan.notebook}」（${new Date(state.lastSync).toLocaleString()}）。`
              : `没有同步到内容；请检查思源是否在运行、笔记本「${siyuan.notebook}」是否存在。`
          }
        } catch (error) {
          return { kind: 'error', text: `同步失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }), log)

  // ── 2c) /dream：立即整理记忆（夜梦六阶段） ────────────────────────────────
  useService(ctx, 'commands', (service) =>
    service.register({
      name: 'dream',
      description: '立即整理记忆（夜梦六阶段）',
      recordInput: false,
      handler: async (invocation) => {
        try {
          const agent = invocation?.agent
            ?? (dreamState.lastCyreneSessionId !== ''
              ? findAgent(dreamState.lastCyreneSessionId)
              : undefined)
          const result = await triggerDream(agent)
          return result.ok === true ? { kind: 'success', text: result.message } : { kind: 'error', text: result.error }
        } catch (error) {
          return { kind: 'error', text: `启动失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }), log)

  // ── 2d) /memory-backup：立即维护 + 快照备份 ───────────────────────────────
  useService(ctx, 'commands', (service) =>
    service.register({
      name: 'memory-backup',
      description: '立即执行维护（同步思源）并快照备份记忆目录',
      recordInput: false,
      handler: async () => {
        try {
          await runMaintenance('manual')
          // 手动备份 = 明确意图：强制重做当日快照（覆盖旧的），保证包含最新内容。
          const snap = snapshotRoot(root, { keep: cfg.backup.keep, force: true })
          return snap.ok === true
            ? { kind: 'success', text: `已维护并备份：${snap.path}` }
            : { kind: 'error', text: `维护完成，备份失败：${snap.error}` }
        } catch (error) {
          return { kind: 'error', text: `备份失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }), log)

  // ── 2e) /memory-restore：从思源回灌（灾难恢复；默认只补缺失） ────────────
  useService(ctx, 'commands', (service) =>
    service.register({
      name: 'memory-restore',
      description: '从思源「93-昔涟」回灌记忆（默认只补本地缺失；/memory-restore force 覆盖锚点与梦志）',
      recordInput: true,
      handler: async (invocation) => {
        try {
          if (siyuan.enabled !== true) return { kind: 'error', text: '思源镜像未开启，无法回灌。' }
          const raw = String(invocation?.line ?? invocation?.input ?? invocation?.text ?? '')
          const force = /\bforce\b/i.test(raw)
          const report = await restoreFromSiYuan(siyuan, root, { force })
          if (report.ok !== true && report.notebook === '') {
            return { kind: 'error', text: `回灌失败：${report.errors[0] ?? '未知原因'}` }
          }
          const lines = [
            `回灌完成${force ? '（force）' : ''}：`,
            `条目 +${report.entries.added}（跳过 ${report.entries.skipped}）`,
            `锚点 ${report.anchors.restored} 份｜梦志 ${report.journals.restored} 篇`,
            `扫描文档：日档 ${report.docs.days} / 锚点 ${report.docs.anchors} / 梦志 ${report.docs.journals}`,
            ...(report.errors.length > 0 ? [`错误：${report.errors.slice(0, 3).join('；')}`] : [])
          ]
          return { kind: report.ok === true ? 'success' : 'error', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: `回灌失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }), log)

  // ── 3) 每轮注入（只有 Cyrene 预设会话） ──────────────────────────────────
  /**
   * 会话 → 预设 id 的跟踪表。
   *
   * 为什么不能只看 session.header.agentPreset：实测（2026-10-18）昔涟聊天会话的 header
   * 记的是 `standard`，而真实选择是 `chat`（会话日志里的 agent-preset/selected 事件、
   * 以及 agentPresets.composedPreset(agent.ctx) 才是准的）。只看 header 会静默不注入。
   */
  const presetBySession = new Map()
  const MAX_PRESET_TRACK = 128
  const rememberPreset = (sessionId, preset) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof preset !== 'string' || preset === '') return
    presetBySession.delete(sessionId)
    presetBySession.set(sessionId, preset)
    while (presetBySession.size > MAX_PRESET_TRACK) {
      const oldest = presetBySession.keys().next()
      if (oldest.done === true) break
      presetBySession.delete(oldest.value)
    }
  }

  /** 注入诊断日志（<root>/元/注入.log，按大小滚动；只记元数据，不记记忆内容）。 */
  const diagLog = (line) => {
    try {
      const file = `${root}/元/注入.log`
      appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
      const size = statSync(file).size
      if (size > 256 * 1024) writeFileSync(file, '')
    } catch {
      /* 诊断日志失败静默 */
    }
  }

  /** 判断本会话用哪个预设；返回 '' 表示未识别。 */
  const detectPreset = (agent, header) => {
    const sessionId = String(agent?.session?.id ?? '')
    try {
      const registry = ctx.get('agentPresets')
      if (registry !== null && typeof registry === 'object' && typeof registry.composedPreset === 'function') {
        const composed = registry.composedPreset(agent?.ctx)
        if (typeof composed === 'string' && composed !== '') return composed
      }
    } catch {
      /* 服务缺失时回退 */
    }
    const tracked = presetBySession.get(sessionId)
    if (typeof tracked === 'string' && tracked !== '') return tracked
    return typeof header?.agentPreset === 'string' ? header.agentPreset : ''
  }

  const presetAllowed = (preset) => {
    if (cfg.injectAll === true) return true
    if (typeof preset !== 'string' || preset === '') return false
    return cfg.injectPresets.includes('*') || cfg.injectPresets.includes(preset)
  }

  // ── 3a) 恒定提示词（agent 作用域）：静态 section + {{cyrene_memory}} 常量指针 ──
  // host 级注册会污染所有会话（provider 拿不到会话/预设），所以挂到 Agent.ctx 上，
  // 只对该 agent 生效；chat 预设是 complete:true，section 可能被压掉，变量是兜底通道。
  const promptInstalls = new Map()
  const promptLog = (line) => {
    try {
      appendFileSync(join(root, '元', '提示词.log'), `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* ignore */
    }
  }
  const installAgentPrompt = (agent) => {
    try {
      const agentId = String(agent?.id ?? agent?.session?.id ?? '')
      if (agentId === '') return
      const preset = detectPreset(agent, agent?.session?.header ?? {})
      if (!presetAllowed(preset)) return
      let sp = null
      try {
        sp = agent?.ctx?.get?.('systemPrompt') ?? null
      } catch {
        sp = null
      }
      if (sp === null || typeof sp !== 'object') return
      const disposers = promptInstalls.get(agentId) ?? {}
      if (disposers.section === undefined && typeof sp.section === 'function') {
        try {
          disposers.section = sp.section({ name: 'cyrene-memory:guide', order: 130, text: MEMORY_SECTION_TEXT })
        } catch (error) {
          promptLog(`section 注册失败 agent=${agentId} ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (disposers.variable === undefined && typeof sp.variable === 'function') {
        try {
          disposers.variable = sp.variable('cyrene_memory', () => MEMORY_VARIABLE_TEXT)
        } catch (error) {
          promptLog(`variable 注册失败 agent=${agentId} ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      promptInstalls.set(agentId, disposers)
      promptLog(`installed agent=${agentId} preset=${JSON.stringify(preset)} section=${disposers.section !== undefined} variable=${disposers.variable !== undefined}`)
    } catch (error) {
      promptLog(`install error ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  ctx.on('agent/created', (payload) => {
    try {
      installAgentPrompt(payload?.agent ?? payload)
    } catch {
      /* ignore */
    }
  })
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent ?? payload
      const agentId = String(agent?.id ?? agent?.session?.id ?? '')
      const disposers = promptInstalls.get(agentId)
      if (disposers === undefined) return
      for (const dispose of Object.values(disposers)) {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
      promptInstalls.delete(agentId)
    } catch {
      /* ignore */
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (!cfg.injectEnabled || decision?.kind !== 'enter') return decision
      const agent = payload?.agent
      const session = agent?.session
      const header = session?.header ?? {}
      const sessionId = String(session?.id ?? '')
      const preset = detectPreset(agent, header)
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      // 夜梦触发标记（schedule 投递或 /dream 手动）优先处理：与预设注入互不干扰。
      const markerMsg = messages.find((m) => textOf(m).includes(DREAM_MARKER))
      if (markerMsg !== undefined) return handleDreamTrigger(decision, messages, markerMsg, sessionId)
      if (!presetAllowed(preset)) {
        const state = sessionState(sessionId)
        if (state.skipLogged !== true) {
          state.skipLogged = true
          diagLog(`skip session=${sessionId} preset=${JSON.stringify(preset)} header=${JSON.stringify(header?.agentPreset)}`)
        }
        return decision
      }
      // 记住最近的 Cyrene 会话，并确保它有每日夜梦任务。
      if (dreamState.lastCyreneSessionId !== sessionId) {
        dreamState.lastCyreneSessionId = sessionId
        saveDreamState(root, dreamState)
      }
      if (dreamState.schedules[sessionId] === undefined) void ensureDreamSchedule(sessionId)
      const userMessages = messages.filter((m) => m?.source?.kind === 'user')
      if (userMessages.length === 0) return decision
      const lastUser = userMessages[userMessages.length - 1]
      const userText = textOf(lastUser)
      // 审计：本会话用户这轮说了什么 → 判断之前注入的记忆有没有被「用上」。
      try {
        noteUserTurn(root, userText)
      } catch {
        /* 审计失败不影响注入 */
      }
      const state = sessionState(sessionId)
      let block = null
      if (!state.firstDone || state.reinject) {
        block = buildFirstSnapshot(root, { nearLimit: 3 })
        state.firstDone = true
        state.reinject = false
      } else if (cfg.hitTopK > 0) {
        let topK = cfg.hitTopK
        try {
          topK = effectiveHitTopK(root, cfg.hitTopK)
        } catch {
          topK = cfg.hitTopK
        }
        const hit = buildHitBlock(root, userText, { topK, excludeIds: state.seen })
        if (hit.text !== '' && hit.text !== state.lastText) {
          block = hit
          markUsed(hit.ids, bumpReview)
        }
      }
      if (block === null || block.text === '') return decision
      if (block.text === state.lastText) return decision
      state.lastText = block.text
      for (const id of block.ids) state.seen.add(id)
      try {
        noteInjection(root, { ids: block.ids, kws: block.kws ?? [] })
      } catch {
        /* 审计失败不影响注入 */
      }
      const at = messages.indexOf(lastUser)
      const out = messages.slice()
      out.splice(at < 0 ? messages.length : at, 0, createPluginMessage(block.text))
      diagLog(`inject session=${sessionId} preset=${JSON.stringify(preset)} first=${state.firstDone} chars=${block.text.length} ids=${block.ids.length}`)
      return { ...decision, messages: out }
    } catch (error) {
      log('warn', `pre-step 注入失败（已放行原始请求）：${error instanceof Error ? error.message : String(error)}`)
      diagLog(`error ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  // ── 4) 压缩后重注入 + 预设选择跟踪 + 夜梦收尾 ───────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      if (event?.type === 'agent-preset/selected') {
        rememberPreset(sessionId, event?.data?.agentPreset)
        return
      }
      if (event?.type === 'turn/end') {
        const reason = event?.data?.reason
        const kind = typeof reason === 'string' ? reason : String(reason?.kind ?? '')
        finalizeDream(sessionId, kind)
        return
      }
      if (event?.type !== 'compaction/end') return
      if (event?.data?.error) return
      if (sessionId !== '') armReinject(sessionId)
    } catch {
      /* 忽略 */
    }
  })

  // 会话销毁：清掉它的夜梦任务，避免孤儿任务反复投递。
  ctx.on('session/disposed', (session) => {
    try {
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      const entry = dreamState.schedules[sessionId]
      if (entry === undefined) return
      const svc = ctx.get('schedule')
      if (svc !== null && typeof svc === 'object' && typeof svc.delete === 'function' && entry.id !== '') {
        void svc.delete({ sessionId, id: entry.id })
      }
      delete dreamState.schedules[sessionId]
      saveDreamState(root, dreamState)
      metaLog('日程.log', `deleted session=${sessionId}`)
    } catch {
      /* ignore */
    }
  })

  // ── 5) 旧记忆迁移（一次性；幂等） ────────────────────────────────────────
  try {
    const legacy = resolve(process.env.DSH_HOME || `${process.env.HOME || process.env.USERPROFILE || '.'}/.dsh`, 'cyrene-memory.md')
    const result = migrateLegacy(root, legacy, {})
    if (result.ok === true && result.count > 0) {
      log('info', `已迁移旧记忆 ${result.count} 条（备份：${result.backup ?? '无'}）`)
    }
  } catch (error) {
    log('warn', `旧记忆迁移失败（不影响使用）：${error instanceof Error ? error.message : String(error)}`)
  }

  // ── 6) 启动兜底 + 定时任务（保存 / 同步 / 备份） ─────────────────────────
  try {
    if (clearStaleLease(dreamState) === true) saveDreamState(root, dreamState)
  } catch {
    /* ignore */
  }
  const initial = setTimeout(() => {
    mirrorDirtyAnchors = true
    mirrorDirtyFree = true
    void flushMirror()
    void runMaintenance('startup')
    if (dreamState.lastCyreneSessionId !== '') void ensureDreamSchedule(dreamState.lastCyreneSessionId)
    // 给启动前就已存在的活 agent 补装恒定提示词（agent/created 不会为它们补发）
    try {
      for (const agent of listAgents()) installAgentPrompt(agent)
    } catch {
      /* ignore */
    }
  }, 5000)
  try {
    ctx.effect(() => () => {
      clearTimeout(initial)
      if (mirrorTimer !== null) clearTimeout(mirrorTimer)
    })
  } catch {
    /* ignore */
  }

  // 定时维护：每 intervalMinutes 同步思源 + 检查配额 + 每日快照（03:00 后第一次 tick 做）
  // 用自调度 setTimeout（不用 ctx.timer 服务：属性访问需 inject 声明，软取在 0.2.1 也拿不到）。
  if (cfg.backup.enabled === true) {
    try {
      const intervalMs = Math.max(60_000, cfg.backup.intervalMinutes * 60_000)
      let stopped = false
      let handle = null
      const schedule = () => {
        if (stopped) return
        handle = setTimeout(() => {
          handle = null
          void runMaintenance('tick').finally(() => {
            schedule()
          })
        }, intervalMs)
      }
      schedule()
      try {
        ctx.effect(() => () => {
          stopped = true
          if (handle !== null) clearTimeout(handle)
        })
      } catch {
        /* ignore */
      }
      metaLog('维护.log', `timer start interval=${cfg.backup.intervalMinutes}min snapshotHour=${cfg.backup.snapshotHour} keep=${cfg.backup.keep}`)
    } catch (error) {
      metaLog('维护.log', `timer failed ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 7) 设置面板 HTTP 路由（Client 插件用） ───────────────────────────────
  useService(ctx, 'webServer', (service) => {
    if (service === null || typeof service !== 'object' || typeof service.register !== 'function') return undefined
    const dispose = service.register({ kind: 'prefix', path: '/cyrene-memory', handler: handleHttp })
    log('info', '已注册 /cyrene-memory 状态/操作路由')
    return dispose
  }, log)

  // 暴露给调试/测试（不参与宿主契约）
  apply.__internals = { root, cfg, siyuan, dreamState, writeEntry, tools, flushMirror, runMaintenance, ensureDreamSchedule, buildStatus }
}

