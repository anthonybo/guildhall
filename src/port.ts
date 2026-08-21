/**
 * Which port the browser view listens on, and how a free one is chosen.
 *
 * Its own module because three surfaces need the same answer — the terminal's port
 * prompt, the menu bar's field, and the config defaults — and "what is a safe port"
 * is exactly the kind of question this codebase has already had four different
 * answers to at once.
 */
import net from 'node:net'

/**
 * The default, and why this number.
 *
 * **4319, chosen by the person who runs this rather than by the elimination below.**
 * That is the honest account: the port was already in use on their phone and in their
 * dev loop, and a default that matches what somebody already types is worth more than a
 * default that scores better on paper.
 *
 * It was 4318 before, which is the OpenTelemetry OTLP/HTTP port by convention — any
 * machine running a collector (jaeger, the otel collector, tempo) already holds it, and
 * a developer's machine is the only kind this program runs on. That was a real failure,
 * not a theoretical one.
 *
 * **The tradeoff being accepted, stated plainly:** 4319 is one above OTLP/HTTP and two
 * above OTLP/gRPC. It is not assigned in `/etc/services` and nothing standard claims it,
 * but it sits in that family, so a collector configured with a non-default HTTP port
 * could land on it. If that ever happens, the Random button exists for exactly this.
 *
 * The measured alternative, kept because the method is worth more than the number: over
 * 1024-9999, exclude everything assigned in `/etc/services`, everything listening,
 * everything declared in any local checkout, every well-known dev-tool default, and
 * everything within four ports of any of those. The largest clear run was 4205-4295,
 * whose midpoint 4250 has about 45 ports of space each way. That is what the randomize
 * band still draws from.
 *
 * **A high, obscure port would be wrong, and was the first answer.** On macOS
 * `net.inet.ip.portrange.first` is 32768, so anything above it can be taken by an
 * outgoing connection's ephemeral allocation — a listener up there works until the day
 * it does not. The 40000-49150 range was measured and discarded for this.
 */
export const DEFAULT_PORT = 4319

export const PORT_MIN = 1024
export const PORT_MAX = 65535
export const okPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= PORT_MIN && (n as number) <= PORT_MAX

/**
 * The band a randomized port is drawn from: exactly the clear run the default sits in,
 * so every number the button can produce has been through the same elimination — not
 * merely "probably free right now", but not claimed by anything on this machine and not
 * adjacent to anything that is. Ninety-one candidates is plenty for a button, and each
 * one is bind-tested before it is offered anyway.
 */
const PICK_LO = 4205
const PICK_HI = 4295

/**
 * Can we actually listen there?
 *
 * By binding, not by asking `lsof`. A port can be held by a process this user cannot
 * see, reserved by the system, or refused for a reason neither of those explains, and
 * the only question that matters is whether OUR listen() succeeds — which is the last
 * step of the chain the browser depends on.
 *
 * Bound on the host it will really be served on, and see `portFree` below for why one
 * bind is not enough: the wildcard and loopback are NOT equivalent on macOS, in the
 * direction opposite to the obvious guess.
 */
function bindable(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = net.createServer()
		// exclusive so this never reports success by sharing with an existing listener
		srv.once('error', () => resolve(false))
		srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)))
	})
}

export async function portFree(port: number, host = '0.0.0.0'): Promise<boolean> {
	if (!(await bindable(port, host))) return false
	/**
	 * The wildcard case also has to check LOOPBACK, and this is not belt-and-braces —
	 * it was measured, and it is the exact situation that started this.
	 *
	 * On macOS, binding `0.0.0.0:p` SUCCEEDS while another process holds
	 * `127.0.0.1:p`. Node sets SO_REUSEADDR, and BSD allows a wildcard bind alongside
	 * a specific-address one. A test written on the assumption that the wildcard is
	 * blocked fails, which is how this was found.
	 *
	 * So a bind test alone would have called jaeger's port free — and serving there
	 * would mean every request to `localhost` reaches jaeger while only the LAN address
	 * reaches guildhall. That is worse than a refusal, because it looks like it worked.
	 */
	if (host === '0.0.0.0' || host === '::') return bindable(port, '127.0.0.1')
	return true
}

/**
 * A free port, or null if the band is somehow full.
 *
 * Random rather than sequential from the default: two machines set up the same way
 * should not both land on the same "next" port, and somebody pressing the button twice
 * expects a different answer.
 *
 * Every candidate is bind-tested, so this cannot hand back a port that is taken — the
 * point of the button is to end a conflict, and suggesting another conflict would be
 * worse than suggesting nothing.
 */
export async function pickPort(host = '0.0.0.0', tries = 40): Promise<number | null> {
	const span = PICK_HI - PICK_LO + 1
	const seen = new Set<number>()
	for (let i = 0; i < tries; i++) {
		const port = PICK_LO + Math.floor(Math.random() * span)
		if (seen.has(port)) continue
		seen.add(port)
		if (await portFree(port, host)) return port
	}
	return null
}
