/**
 * Delivering a message at most once, however many times it is asked for.
 *
 * "I have to send everything twice" is the oldest open bug here. Five fixes were tried
 * and MISTAKES.md records all of them; every one reasoned about the mechanism inside
 * cmux, and the mechanism inside cmux was never the problem.
 *
 * The problem is that a lost REPLY is indistinguishable from a lost REQUEST. The client
 * hands the text back to the box on any failure, including a network error that arrives
 * after the server has already delivered the message perfectly — so the send that
 * "failed" went through, and pressing Send again delivers it a second time. That is why
 * it is the first message after the machine has slept: it is the request that discovers
 * the connection went stale overnight.
 *
 * No amount of care inside the send path can fix that, because both sides are behaving
 * correctly and neither can tell what happened. What fixes it is naming the message: the
 * client generates a key once, per composed message, and reuses it on every retry. The
 * second delivery of a key already spent returns what the first one returned and types
 * nothing.
 *
 * The virtue of this over the previous five attempts is that it does not depend on the
 * diagnosis above being right. Whatever drops — a radio, a sleeping laptop, a proxy, a
 * double tap, a browser retry — a duplicate cannot reach the session.
 */

/** What a completed send returned, so a repeat can be answered identically. */
export type Spent = { status: number; body: string }

/**
 * How long a key is remembered.
 *
 * Long enough to cover a person noticing nothing happened and pressing Send again,
 * which is the window that matters and is a few seconds at most. Two minutes is
 * generous for that and short enough that a genuinely new message reusing a key by
 * accident is not a thing that can happen — the keys are random.
 */
const TTL = 120_000
/**
 * A ceiling, so a caller inventing keys cannot grow this without limit. Sends are
 * typed by a person: a hundred inside two minutes is already far beyond real use.
 */
const MAX = 200

const spent = new Map<string, { at: number; result?: Spent }>()

/** Test seam. The clock is passed in nowhere else, so this stays a module detail. */
export function resetOnce() {
	spent.clear()
}

const sweep = (now: number) => {
	for (const [k, v] of spent) if (now - v.at > TTL) spent.delete(k)
	// Still too many after expiry: drop the oldest. Map keeps insertion order.
	while (spent.size > MAX) {
		const oldest = spent.keys().next().value
		if (oldest === undefined) break
		spent.delete(oldest)
	}
}

/**
 * Claim a key before doing the work.
 *
 * Returns `null` when the key is new and the caller should go ahead, or the previous
 * outcome when it is not. A claim is recorded IMMEDIATELY, before the send is attempted,
 * so two requests arriving together cannot both pass — the second gets `{ pending: true }`
 * rather than a result, and is told the message is already on its way rather than being
 * sent a second time.
 */
export function claim(key: string, now = Date.now()): { pending: true } | { done: Spent } | null {
	sweep(now)
	const had = spent.get(key)
	if (had) return had.result ? { done: had.result } : { pending: true }
	spent.set(key, { at: now })
	return null
}

/** Record what the send returned, so a retry of the same key is answered with it. */
export function finish(key: string, result: Spent, now = Date.now()) {
	const had = spent.get(key)
	if (!had) return
	// And only if the claim has not already outlived its window. A send slower than the
	// TTL would otherwise write back a key nobody is holding any more, and a much later
	// retry would be answered from it. Caught by a test rather than reasoned about: the
	// first version checked only that the entry existed, and nothing sweeps between a
	// claim and its finish.
	if (now - had.at > TTL) {
		spent.delete(key)
		return
	}
	spent.set(key, { at: now, result })
}

/**
 * Forget a claim.
 *
 * Used when the send never happened — a refusal before anything was typed. Those must
 * not burn the key, or correcting the cause and pressing Send again would be answered
 * with the old refusal forever.
 */
export function release(key: string) {
	const had = spent.get(key)
	if (had && !had.result) spent.delete(key)
}
