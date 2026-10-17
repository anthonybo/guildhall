#!/usr/bin/env node
/**
 * guildhall — every live Claude Code session as a pixel town, in a terminal.
 *
 * Read-only. It watches the sessions you already run (in cmux or anywhere else)
 * and never launches or modifies one. The only thing it writes is a cmux
 * "focus this tab" request, and only when you press enter.
 *
 * The entry point and nothing else; the program is in `main/`, split by concern.
 */

// The one-shot flags first. Each prints its answer and exits, so none of them may
// find the room half started underneath it.
import './main/commands.ts'

// Loaded only after every one-shot flag has had its turn, rather than imported
// statically beside it. The commands module awaits at top level (`--port-free`,
// `--pick-port`, `--usage`), and under native ES modules a sibling import does not
// wait for that: the room module would run its own top level — reading flags into
// the config, configuring the sleep hold — while a command was still deciding to exit.
// It was one file before, where statement order alone guaranteed that.
const { main } = await import('./main/room.ts')
main()
