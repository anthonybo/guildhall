/** The three helpers every module here needs, and nothing else. */

export const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T

export const rgb = (c: readonly number[]) => `rgb(${c[0]} ${c[1]} ${c[2]})`

/** A duration in words. Rounded, because "how long" is the question, not "exactly how long". */
export const ago = (ms: number) => {
	const m = Math.round(ms / 60000)
	if (m < 1) return 'now'
	if (m < 60) return `${m}m`
	const h = Math.round(m / 60)
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}
