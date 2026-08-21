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
 * It was **4318**, which is the OpenTelemetry OTLP/HTTP port by convention. Any
 * machine running a collector — jaeger, the otel collector, tempo — already has it,
 * and a developer's machine is the only kind this program runs on. Reported as
 * "something else is using this port": a jaeger instance holding 127.0.0.1:4318.
 *
 * 4250 was chosen by measurement rather than taste. Four digits, because a port people
 * type into a phone should be short. Then, over the whole 1024-9999 range, everything
 * was excluded that is:
 *
 *  - assigned in `/etc/services`;
 *  - listening on that machine at the time, which included the OTLP family at
 *    4317-4319 — the collision that started this;
 *  - declared as a port anywhere in the checkouts on the machine this was chosen on
 *    (the specific numbers are somebody's private setup and are deliberately not
 *    listed here — the method is what matters, and it should be re-run rather than
 *    trusted if this ever needs choosing again);
 *  - a well-known dev-tool default (3000, 4200, 5432, 6379, 8080, 9090, 11434, …);
 *  - within four ports of any of the above, so a neighbouring service appearing later
 *    does not land on top of this one.
 *
 * The largest clear run left was 4205-4295, and this is its midpoint: about 45 ports
 * of space in each direction. Nothing was listening on it, and it is unassigned.
 *
 * **A high, obscure port would be wrong, and that was the first answer.** On macOS
 * `net.inet.ip.portrange.first` is 32768, so anything above it can be taken by an
 * outgoing connection's ephemeral allocation — a listener up there works until the day
 * it does not. The 40000-49150 range was measured and discarded for this.
 */
export const DEFAULT_PORT = 4250

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
