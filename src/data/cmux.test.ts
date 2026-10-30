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
const { cmuxMap, heldForTest, seatFields, tabForTty, unclaimed } = await import('./cmux.ts')

const panel = (terminal: unknown) => ({ terminal })
const write = (workspaces: unknown[]) => fs.writeFileSync(state, JSON.stringify({ windows: [{ tabManager: { workspaces } }] }))

/** A panel cmux still considers attached: both fields, carrying the same id. */
const attached = (id: string) => panel({ agent: { kind: 'claude', sessionId: id }, resumeBinding: { kind: 'claude', checkpointId: id }, wasAgentRunning: true })

/** The same panel after cmux stopped hearing from the agent: `agent` is gone. */
const detached = (id: string) => panel({ resumeBinding: { kind: 'claude', checkpointId: id }, wasAgentRunning: false })

test('a panel cmux still calls attached maps to its workspace', () => {
	write([{ workspaceId: 'W1', panels: [attached('s1')] }])
	assert.deepEqual(cmuxMap().get('s1'), { tab: 1, workspace: 'W1', unread: false, panes: [] })
})

test('a detached panel still maps — the tab is there and the session is alive', () => {
	// The regression this file exists for. cmux drops `terminal.agent` once
	// `wasAgentRunning` goes false, which happened to a live `claude --resume`
	// sitting in a visible tab; reading `agent` alone lost the terminal button.
	write([{ workspaceId: 'W1', panels: [detached('s1')] }])
	assert.deepEqual(cmuxMap().get('s1'), { tab: 1, workspace: 'W1', unread: false, panes: [] })
})

test('tab is the 1-based position, and unread comes from the workspace', () => {
	write([
		{ workspaceId: 'W1', panels: [] },
		{ workspaceId: 'W2', panels: [detached('s2')], hasUnreadIndicator: true },
	])
	assert.deepEqual(cmuxMap().get('s2'), { tab: 2, workspace: 'W2', unread: true, panes: [] })
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

test('in a split tab a session is seated in ITS pane, not the focused one, and the others are listed', () => {
	// As reported on a real project: Claude on the left, a backlog TUI focused on the right. The
	// tab alone resolved to the backlog, so the browser showed it instead of the chat.
	const CHAT = '0381434D-1330-4105-AEC8-25C08754FB4D'
	const BACKLOG = '3704304F-A35B-4DCE-B4D7-86AB910C17C1'
	write([
		{
			workspaceId: 'W1',
			focusedPanelId: BACKLOG,
			panels: [
				{ id: CHAT, type: 'terminal', title: 'TEST-ONLY game handoff', ttyName: 'TEST-ONLY-tty-chat', ...attached('s1') },
				{ id: BACKLOG, type: 'terminal', title: 'Backlog', customTitle: 'Backlog', ttyName: 'TEST-ONLY-tty-backlog', terminal: {} },
			],
		},
	])
	const seat = cmuxMap().get('s1')
	assert.equal(seat?.surface, CHAT)
	assert.deepEqual(
		seat?.panes.map((p) => p.title),
		['TEST-ONLY game handoff', 'Backlog'],
	)
	assert.equal(seatFields(seat!).panes?.length, 2)
	// One pane: nothing to choose between, so no list is offered.
	write([{ workspaceId: 'W2', panels: [{ id: CHAT, type: 'terminal', title: 'x', ...attached('s2') }] }])
	assert.equal(seatFields(cmuxMap().get('s2')!).panes, undefined)
	assert.equal(cmuxMap().get('s2')?.surface, CHAT)
})

test('reading the state on every poll holds one read, not every read ever made', () => {
	// The memory leak: every poll appended each agentless tab to a list that only a session
	// start ever emptied — 1,950,036 entries and 977MB after 71 hours of polling.
	const PANE = '0381434D-1330-4105-AEC8-25C08754FB4D'
	write([
		{ workspaceId: 'W1', currentDirectory: '/tmp/TEST-ONLY-a', panels: [{ id: PANE, type: 'terminal', ttyName: '/dev/TEST-ONLY-tty', terminal: {} }] },
		{ workspaceId: 'W2', currentDirectory: '/tmp/TEST-ONLY-b', panels: [] },
	])
	for (let i = 0; i < 500; i++) cmuxMap()
	assert.deepEqual(heldForTest(), { free: 2, ttys: 2 })
	assert.deepEqual(
		unclaimed().map((u) => u.dir),
		['/tmp/TEST-ONLY-a', '/tmp/TEST-ONLY-b'],
	)
	assert.equal(tabForTty('TEST-ONLY-tty')?.workspace, 'W1')
	// A tab that closed is forgotten by the next read rather than kept.
	write([{ workspaceId: 'W2', currentDirectory: '/tmp/TEST-ONLY-b', panels: [] }])
	cmuxMap()
	assert.deepEqual(heldForTest(), { free: 1, ttys: 0 })
	assert.equal(tabForTty('TEST-ONLY-tty'), undefined)
})
