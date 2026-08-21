/**
 * The port policy, which had a real bug in it: the default was 4318, the OTLP/HTTP
 * port, so any machine running a trace collector already held it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'

import { DEFAULT_PORT, PORT_MAX, PORT_MIN, okPort, pickPort, portFree } from './port.ts'

/**
 * macOS hands out ephemeral ports from 32768 up, so a listener above that line works
 * until an outgoing connection happens to take the same number. This is the constraint
 * that ruled out "pick something high and obscure", which was the obvious answer and
 * the wrong one — the whole 40000-49150 range was considered and discarded for it.
 */
const EPHEMERAL_FLOOR = 32768

test('the default port is below the ephemeral floor, and is not a port anything else wants', () => {
	assert.ok(DEFAULT_PORT < EPHEMERAL_FLOOR, `${DEFAULT_PORT} is in the ephemeral range and will conflict at random`)
	assert.ok(okPort(DEFAULT_PORT), 'the default is outside the range the config will accept')
	assert.ok(DEFAULT_PORT > 1024, 'below 1024 needs root on macOS')
	// Four digits: this is a number people type into a phone's address bar.
	assert.ok(DEFAULT_PORT >= 1024 && DEFAULT_PORT <= 9999, `${DEFAULT_PORT} is not a four-digit port`)

	// The collision this moved away from, plus the crowd any default must stay out of.
	// Only well-known public defaults are listed: the ports that were actually in use on
	// the machine where 4250 was chosen are somebody's private setup, and a public test is
	// not the place for them. src/port.ts records the method instead.
	// 4318/4317 are OpenTelemetry, which is what actually happened here — jaeger held
	// 127.0.0.1:4318 and the panel could only say "choose another port".
	const taken = new Set([
		4317, 4318, 4319, 3000, 3001, 4000, 4200, 5000, 5173, 5432, 6379, 7000, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 9200, 11434, 27017,
	])
	assert.ok(!taken.has(DEFAULT_PORT), `${DEFAULT_PORT} is a well-known default for something else`)
})

test('a picked port is one we can actually listen on', async () => {
	// Bind-tested, not looked up. The point of the button is to end a conflict, so
	// handing back another conflict would be worse than handing back nothing.
	const port = await pickPort('127.0.0.1')
	assert.ok(port !== null, 'no free port could be found at all')
	assert.ok(okPort(port!), `${port} is outside the acceptable range`)
	assert.ok(port! < EPHEMERAL_FLOOR, `${port} is in the ephemeral range`)
	// and it really is free, right now, which is the only claim that matters
	assert.equal(await portFree(port!, '127.0.0.1'), true, 'the port it chose is already in use')
})

test('a port in use is reported as in use, on the host that holds it', async () => {
	// The guard that makes the button honest. Without this test `portFree` returning a
	// hardcoded true would pass everything above.
	const srv = net.createServer()
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
	const held = (srv.address() as net.AddressInfo).port
	try {
		assert.equal(await portFree(held, '127.0.0.1'), false, 'a port with a listener on it was reported free')
		// 0.0.0.0 must fail too: something on loopback blocks binding every interface,
		// and treating those as independent is how a "free" port refuses to bind.
		assert.equal(await portFree(held, '0.0.0.0'), false, 'loopback holder did not block the wildcard bind')
	} finally {
		await new Promise<void>((r) => srv.close(() => r()))
	}
	// and free again once the holder lets go, so the check is live rather than cached
	assert.equal(await portFree(held, '127.0.0.1'), true, 'the port stayed marked in use after its listener closed')
})

test('the accepted range refuses what the OS would refuse', () => {
	assert.equal(okPort(80), false, 'a privileged port was accepted')
	assert.equal(okPort(PORT_MIN - 1), false)
	assert.equal(okPort(PORT_MAX + 1), false)
	assert.equal(okPort(PORT_MIN), true)
	assert.equal(okPort(PORT_MAX), true)
	assert.equal(okPort(3000.5), false, 'a fractional port was accepted')
	assert.equal(okPort('3000'), false, 'a string was accepted, so a config value would pass unparsed')
})
