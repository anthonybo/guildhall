/**
 * Where the facts live on disk.
 *
 * Nothing here is installed or configured: Claude Code already writes a registry
 * entry per running process, keeps a transcript per session, and cmux already
 * writes its own window layout. Guildhall only reads.
 */
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

/** One JSON file per running process, named for its PID. */
export const SESS_DIR = path.join(HOME, '.claude', 'sessions')
/** One directory per project slug, holding `<sessionId>.jsonl` transcripts. */
export const PROJ_DIR = path.join(HOME, '.claude', 'projects')
/** cmux's window layout, which is how a session maps to a tab we can jump to. */
export const CMUX_STATE = path.join(HOME, 'Library/Application Support/cmux/session-com.cmuxterm.app.json')
