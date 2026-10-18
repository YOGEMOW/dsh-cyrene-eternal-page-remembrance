import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const client = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('client bundle id 必须等于 package.json 包名（2026-10-18 web-boot 崩溃回归）', () => {
  const match = /window\.__ModuleLoader__\.load\(\{[\s\S]{0,400}?id:\s*['"]([^'"]+)['"]/.exec(client)
  assert.ok(match !== null, 'client.js 里找不到 __ModuleLoader__.load({ id })')
  assert.equal(match[1], pkg.name, `client bundle id (${match[1]}) 必须等于包名 (${pkg.name})`)
})

test('client 清单与导出齐全', () => {
  assert.ok(pkg.dsh?.client !== undefined, 'package.json 缺少 dsh.client')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(typeof pkg.exports['./client'], 'string')
  assert.ok(pkg.files.includes('client.js'), 'files 必须包含 client.js')
})

test('client.js 不 import @deepseek-ai/dsh-client-* 内部包', () => {
  assert.equal(/from\s+['"]@deepseek-ai\/dsh-client-/.test(client), false)
  assert.equal(/require\(\s*['"]@deepseek-ai\/dsh-client-/.test(client), false)
})

test('settings.section 注册必须带 label（否则导航行只有图标没有名字）', () => {
  const match = /slots\.register\(\{[\s\S]{0,400}?name:\s*'settings\.section'[\s\S]{0,400}?\}\s*,\s*Panel\s*\)/.exec(client)
  assert.ok(match !== null, '找不到 settings.section 的 slots.register(...)')
  assert.match(match[0], /label:\s*['"`][^'"`]+['"`]/, 'settings.section 注册缺少 label')
})

test('会话头徽标注册存在且带 label', () => {
  const match = /slots\.register\(\{[\s\S]{0,400}?name:\s*'conversation\.session\.header\.actions'[\s\S]{0,400}?\}\s*,\s*HeaderChip\s*\)/.exec(client)
  assert.ok(match !== null, '找不到会话头 action 的 slots.register(...)')
  assert.match(match[0], /label:\s*['"`][^'"`]+['"`]/, '会话头 action 注册缺少 label')
})

test('不得替换官方 conversation.chat.node 渲染（固定 key 表，replaceRisk=shadows-shipped-ui）', () => {
  assert.equal(client.includes("name: 'conversation.chat.node'"), false)
})
