/**
 * Which "user" messages in a transcript are really yours. The history view draws yours
 * as a pink card so they can be found in a long log; anything Claude Code inserted in
 * your name must not get the same card, or the landmark means nothing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { inserted, typedForm } from '../web/said.ts'

test('what Claude Code writes in your name is a notice, not your message', () => {
	const n = inserted('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Death counts" completed (exit code 0)</summary>\n</task-notification>')
	assert.match(n ?? '', /^⚙ background task — Background command "Death counts" completed/)
	assert.match(inserted('This session is being continued from a previous conversation that ran out of context.') ?? '', /summarized/)
	assert.equal(inserted('[Request interrupted by user]'), '⚙ interrupted')
	assert.match(inserted('<local-command-stdout>Compacted. ctrl+o to see full summary</local-command-stdout>') ?? '', /^⚙ output — Compacted/)
	assert.equal(inserted('<bash-stdout></bash-stdout>'), '⚙ output (empty)')
})

test('what you typed stays yours — including commands, and text that merely mentions a tag', () => {
	for (const t of ['fix the backlog panel', '/compact', 'why does <task-notification> show up as me?', '<command-name>/compact</command-name>', '<bash-input>ls</bash-input>']) {
		assert.equal(inserted(t), null, t)
	}
	assert.equal(typedForm('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'), '/model opus')
	assert.equal(typedForm('<bash-input>git status</bash-input>'), '! git status')
	assert.equal(typedForm('plain words'), 'plain words')
})
