import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'

process.env.GUILDHALL_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guildhall-upload-'))

import { kindOf, readBytes, saveUpload, uploadDir } from './upload.ts'

const pad = (head: number[] | string) => Buffer.concat([Buffer.from(head as never), Buffer.alloc(16)])

test('an image is known by its bytes, whatever it claims to be', () => {
	assert.equal(kindOf(pad([0x89, 0x50, 0x4e, 0x47])), 'png')
	assert.equal(kindOf(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
	assert.equal(kindOf(pad('GIF89a')), 'gif')
	assert.equal(kindOf(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.alloc(8)])), 'webp')
	// HEIC is what an iPhone takes; the browser converts it before upload, and the
	// Read tool cannot open it, so it must not be saved as if it were fine.
	assert.equal(kindOf(pad([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])), null)
	assert.equal(kindOf(pad('#!/bin/sh\nrm -rf ~')), null)
	assert.equal(kindOf(Buffer.from([0x89, 0x50])), null)
})

test('a saved image gets an unguessable name of its own type, and refusals save nothing', () => {
	const a = saveUpload(pad([0xff, 0xd8, 0xff, 0xe0]))
	const b = saveUpload(pad([0xff, 0xd8, 0xff, 0xe0]))
	assert.ok(a.ok && b.ok)
	assert.match(a.path, /\/[0-9a-f]{12}\.jpg$/)
	assert.notEqual(a.path, b.path)
	const before = fs.readdirSync(uploadDir()).length
	assert.equal(saveUpload(pad('not an image')).ok, false)
	assert.equal(fs.readdirSync(uploadDir()).length, before)
})

test('uploads older than a week are cleared on the next upload, newer ones kept', () => {
	const dir = uploadDir()
	const old = path.join(dir, 'TEST-ONLY-old.png')
	const recent = path.join(dir, 'TEST-ONLY-recent.png')
	fs.writeFileSync(old, 'x')
	fs.writeFileSync(recent, 'x')
	const day = 24 * 60 * 60 * 1000
	fs.utimesSync(old, new Date(Date.now() - 8 * day), new Date(Date.now() - 8 * day))
	fs.utimesSync(recent, new Date(Date.now() - 6 * day), new Date(Date.now() - 6 * day))
	assert.ok(saveUpload(pad([0x89, 0x50, 0x4e, 0x47])).ok)
	assert.equal(fs.existsSync(old), false)
	assert.equal(fs.existsSync(recent), true)
})

test('a body over the cap is cut off rather than buffered', async () => {
	const req = (n: number) => Object.assign(Readable.from([Buffer.alloc(n)]), { destroy() {} }) as unknown as http.IncomingMessage
	assert.equal(await readBytes(req(11), 10), null)
	assert.equal((await readBytes(req(10), 10))?.length, 10)
})
