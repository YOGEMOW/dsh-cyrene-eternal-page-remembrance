/**
 * 一页永恒 · Client 插件（Phase 3）
 *
 * 只做两件事：
 *  1. 在「设置」里加一个「一页永恒」分区：四问锚点、条目统计、配额、注入利用率、思源镜像状态；
 *  2. 提供「立即同步 / 立即备份 / 立即整理」三个按钮，走宿主侧 /cyrene-eternal-page-remembrance/action。
 *
 * 自注册 lazy factory 形态（DSH Client 插件契约）：
 *  - 不 import 任何 @deepseek-ai/dsh-client-* 包；React 从浏览器模块表 require。
 *  - 用 ctx.slots.inject(owner, () => ctx.slots.register(...))，owner 收起时自动卸载。
 */

window.__ModuleLoader__.load({
  // 必须与 package.json 的包名一致：启动清单按包名生成 entry，
  // 写成宿主实例名会让加载器重跑 bundle，触发重复注册。
  id: 'dsh-cyrene-eternal-page-remembrance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/cyrene-eternal-page-remembrance'

    async function getStatus() {
      const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function postAction(action) {
      const res = await fetch(`${API}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action })
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    }

    const card = {
      border: '1px solid var(--dsw-alias-border, #ddd)',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 12,
      background: 'var(--dsw-alias-surface, transparent)'
    }
    const muted = { opacity: 0.65, fontSize: 12 }
    const row = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
    const btn = {
      padding: '4px 10px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border, #ccc)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer'
    }
    const pre = {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      margin: 0,
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: 1.6
    }

    function Panel() {
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const data = await getStatus()
          setState({ loading: false, error: '', data })
        } catch (error) {
          setState({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, 30000)
        return () => clearInterval(timer)
      }, [refresh])

      const run = async (action) => {
        setBusy(action)
        setNotice('')
        try {
          const result = await postAction(action)
          setNotice(result.message ?? '完成')
          await refresh()
        } catch (error) {
          setNotice(`失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy('')
        }
      }

      if (state.loading) return h('div', { style: card }, '一页永恒：读取中…')
      if (state.error !== '') {
        return h('div', { style: card }, h('div', null, '一页永恒：读取失败'), h('div', { style: muted }, state.error), h('button', { style: btn, onClick: refresh }, '重试'))
      }
      const d = state.data ?? {}
      const anchors = d.anchors ?? {}
      const quota = d.quota ?? {}
      const audit = d.audit ?? {}
      const mirror = d.mirror ?? {}
      return h(
        'div',
        null,
        h(
          'div',
          { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '一页永恒 · 四问锚点'),
          h('pre', { style: pre }, `我是谁：${anchors.self || '（空）'}\n你是谁：${anchors.user || '（空）'}\n我从哪里来：${anchors.origin || '（空）'}\n我要到哪里去：${anchors.goal || '（空）'}`),
          h('div', { style: { ...muted, marginTop: 6 } }, `版本：${anchors.version ?? '—'}｜更新：${anchors.updatedAt ?? '—'}`)
        ),
        h(
          'div',
          { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '状态'),
          h(
            'div',
            { style: pre },
            `条目 ${d.entries?.total ?? 0}（活跃 ${d.entries?.active ?? 0}｜归档 ${d.entries?.archived ?? 0}）\n` +
              `配额 ${(quota.usedMB ?? 0).toFixed(2)} / ${quota.limitMB ?? 0} MB（余页 ${(quota.freeUsedMB ?? 0).toFixed(2)} / ${quota.freeLimitMB ?? 0} MB）\n` +
              `注入利用率 ${(audit.total ?? 0) === 0 || audit.rate === null || audit.rate === undefined ? '暂无样本' : `${Math.round(audit.rate * 100)}%（${audit.used}/${audit.total}）`}｜命中额度 ${audit.effectiveTopK ?? '—'}\n` +
              `思源镜像 ${mirror.enabled ? '已开启' : '关闭'}｜${mirror.notebook ?? '—'}｜上次 ${mirror.lastSync ?? '尚未同步'}\n` +
              `上次夜梦：${d.dream?.lastDreamAt ?? '今天还没整理'}｜每日任务：${d.dream?.scheduled ? '已排程' : '未排程'}`
          )
        ),
        h(
          'div',
          { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '操作'),
          h(
            'div',
            { style: row },
            h('button', { style: btn, disabled: busy !== '', onClick: () => void run('sync') }, busy === 'sync' ? '同步中…' : '立即同步思源'),
            h('button', { style: btn, disabled: busy !== '', onClick: () => void run('backup') }, busy === 'backup' ? '备份中…' : '立即备份'),
            h('button', { style: btn, disabled: busy !== '', onClick: () => void run('dream') }, busy === 'dream' ? '启动中…' : '立即整理'),
            h('button', { style: btn, onClick: refresh }, '刷新')
          ),
          notice === '' ? null : h('div', { style: { ...muted, marginTop: 8 } }, notice)
        )
      )
    }

    /**
     * 会话头小徽标：只在昔涟预设的会话里出现。
     * 宿主 /cyrene-eternal-page-remembrance/session 返回 preset；非 chat/cyrene-work 直接返回 null（不占位）。
     */
    const chipStyle = {
      padding: '2px 8px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border, #ccc)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 12,
      opacity: 0.85,
      whiteSpace: 'nowrap'
    }

    function HeaderChip(props) {
      const sessionId = props?.sessionId
      const [info, setInfo] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      const refresh = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          const res = await fetch(`${API}/session?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
          if (!res.ok) return
          setInfo(await res.json())
        } catch {
          /* 静默：徽标不是关键路径 */
        }
      }, [sessionId])

      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, 60000)
        return () => clearInterval(timer)
      }, [refresh])

      React.useEffect(() => {
        if (note === '') return undefined
        const timer = setTimeout(() => setNote(''), 4000)
        return () => clearTimeout(timer)
      }, [note])

      if (info === null) return null
      if (info.preset !== 'chat' && info.preset !== 'cyrene-work') return null
      const label = info.running ? '忆·梦中' : info.dreamedToday ? '忆·已整理' : '忆·待整理'
      const action = info.dreamedToday ? 'sync' : 'dream'
      const click = async () => {
        setBusy(true)
        setNote('')
        try {
          const result = await postAction(action)
          setNote(result.message ?? '完成')
          await refresh()
        } catch (error) {
          setNote(`失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }
      return h(
        'button',
        {
          style: chipStyle,
          title: note !== '' ? note : `一页永恒：${label}（点击${info.dreamedToday ? '同步思源' : '立即整理'}）`,
          disabled: busy || info.running === true,
          onClick: () => void click()
        },
        busy ? '忆…' : label
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          // label 是导航行显示文字：settings.section 的注册契约是 id + order + label，
          // 漏掉 label 会出现一条「只有图标、没有名字」的空导航（2026-10-18 用户截图指出）。
          ctx.slots.register({ name: 'settings.section', id: 'cyrene-eternal-page-remembrance', order: 90, label: '一页永恒' }, Panel)
        )
        // 会话头小徽标（title-adjacent Session actions）：仅在昔涟会话内渲染。
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({ name: 'conversation.session.header.actions', id: 'cyrene-eternal-page-remembrance', order: 15, label: '一页永恒' }, HeaderChip)
        )
      }
    }
  }
})
