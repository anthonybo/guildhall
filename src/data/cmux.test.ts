import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set before the dynamic import below, because CMUX_STATE is read when the
// module is evaluated and a static import would be hoisted above this line.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-cmux-'))
const state = path.join(dir, 'session.json')
process.env.GUILDHALL_CMUX_STATE = state
const { cmuxMap } = await import('./cmux.ts')

const panel = (terminal: unknown) => ({ terminal })
const write = (workspaces: unknown[]) => fs.writeFileSync(state, JSON.stringify({ windows: [{ tabManager: { workspaces } }] }))

/** A panel cmux still considers attached: both fields, carrying the same id. */
const attached = (id: string) => panel({ agent: { kind: 'claude', sessionId: id }, resumeBinding: { kind: 'claude', checkpointId: id }, wasAgentRunning: true })

/** The same panel after cmux stopped hearing from the agent: `agent` is gone. */
const detached = (id: string) => panel({ resumeBinding: { kind: 'claude', checkpointId: id }, wasAgentRunning: false })

test('a panel cmux still calls attached maps to its workspace', () => {
	write([{ workspaceId: 'W1', panels: [attached('s1')] }])
	assert.deepEqual(cmuxMap().get('s1'), { tab: 1, workspace: 'W1', unread: false })
})

test('a detached panel still maps — the tab is there and the session is alive', () => {
	// The regression this file exists for. cmux drops `terminal.agent` once
	// `wasAgentRunning` goes false, which happened to a live `claude --resume`
	// sitting in a visible tab; reading `agent` alone lost the terminal button.
	write([{ workspaceId: 'W1', panels: [detached('s1')] }])
	assert.deepEqual(cmuxMap().get('s1'), { tab: 1, workspace: 'W1', unread: false })
})

test('tab is the 1-based position, and unread comes from the workspace', () => {
	write([
		{ workspaceId: 'W1', panels: [] },
		{ workspaceId: 'W2', panels: [detached('s2')], hasUnreadIndicator: true },
	])
	assert.deepEqual(cmuxMap().get('s2'), { tab: 2, workspace: 'W2', unread: true })
})

test('every agent-bearing panel of a split workspace maps to it', () => {
	write([{ workspaceId: 'W1', panels: [detached('claude1'), attached('codex1'), panel({ workingDirectory: '/x' })] }])
	const m = cmuxMap()
	assert.equal(m.get('claude1')?.workspace, 'W1')
	assert.equal(m.get('codex1')?.workspace, 'W1')
	assert.equal(m.size, 2)
})

test('a live attachment beats a stale binding for the same session, either order', () => {
	// A binding outlives the attachment, so a panel a session has left can still
	// name it. Whoever actually holds the agent must win regardless of position.
	write([
		{ workspaceId: 'OLD', panels: [detached('s1')] },
		{ workspaceId: 'NOW', panels: [attached('s1')] },
	])
	assert.equal(cmuxMap().get('s1')?.workspace, 'NOW')
	write([
		{ workspaceId: 'NOW', panels: [attached('s1')] },
		{ workspaceId: 'OLD', panels: [detached('s1')] },
	])
	assert.equal(cmuxMap().get('s1')?.workspace, 'NOW')
})

test('no state file, or an unreadable one, is empty rather than fatal', () => {
	fs.rmSync(state)
	assert.equal(cmuxMap().size, 0)
	fs.writeFileSync(state, 'not json')
	assert.equal(cmuxMap().size, 0)
})
