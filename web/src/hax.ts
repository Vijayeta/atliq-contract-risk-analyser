// Supporting data and helpers for the Microsoft HAX Guidelines for Human-AI Interaction
// (Amershi et al., CHI 2019). See Project/AtliQ_HAX_Implementation_Plan.md.
import { useEffect, useState } from 'react'
import type { Severity, UserId } from './data'

/* ----------------------------- G18 — engine changes ----------------------------- */

export const CURRENT_RULES = 'rules-v3.0'

/** "Treat today as 2026-09-28" (Dataset/README.md). Used for time-left and expiry maths. */
export const AS_OF_DATE = new Date(2026, 8, 28)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Parses dataset dates like "31 Mar 2027". Invalid for "Ongoing" or "-". */
export function parseDay(s: string) {
  const [d, m, y] = s.split(' ')
  return new Date(Number(y), MONTHS.indexOf((m ?? '').slice(0, 3)), Number(d)) // "Sept" → "Sep"
}

/** Whole days from AS_OF_DATE to the given date (negative = past). NaN if it isn't a date. */
export function daysFromToday(s: string) {
  return Math.round((parseDay(s).getTime() - AS_OF_DATE.getTime()) / 86_400_000)
}

export interface EngineChange {
  version: string
  date: string
  title: string
  detail: string
  affects: string
}

export const engineChangelog: EngineChange[] = [
  {
    version: 'rules-v3.0',
    date: '28 Sep 2026',
    title: 'Entity rules, checklist and obligation register',
    detail: "Two legal entities only (Pvt Ltd for non-US clients, Inc for US clients); Karandeep's checklist positions; conflict checks against a register built from the 17 signed contracts.",
    affects: 'All existing reviews were regenerated with these rules.',
  },
  {
    version: 'p-2026.10.08',
    date: '08 Oct 2026',
    title: 'Indemnity review checks for delay relief',
    detail: 'Indemnity and delay-penalty clauses are checked for excusable-delay, scope-change and force-majeure relief.',
    affects: 'Reviews from 8 Oct onwards.',
  },
]

/* ----------------------------- G2 — how well it works ----------------------------- */

export function confidenceWord(v: number) {
  return v >= 0.85 ? 'High confidence' : v >= 0.6 ? 'Medium confidence' : 'Low confidence'
}

/* ----------------------------- G11 / G10 — legacy maps ----------------------------- */

/** Severity drivers and detection confidence now come from the backend on each finding/contract. */
export const DRIVERS: Record<string, string[]> = {}
export const DETECT_CONF: Record<string, number> = {}

/* ----------------------------- G17 — global controls ----------------------------- */

export interface Settings {
  showLow: boolean
  showWording: boolean
  showConfidence: boolean
  notify: Record<NotificationKind, boolean>
}

export const defaultSettings: Settings = {
  showLow: true,
  showWording: true,
  showConfidence: true,
  notify: { ready: true, assigned: true, delegation: true, questions: true, engine: true },
}

/* ----------------------------- G3/G18 — notifications ----------------------------- */

export type NotificationKind = 'ready' | 'assigned' | 'delegation' | 'questions' | 'engine'

export const notificationKindLabel: Record<NotificationKind, string> = {
  ready: 'A review is ready',
  assigned: "I'm assigned as a reviewer",
  delegation: 'A delegation is about to end',
  questions: 'A question is routed to me',
  engine: 'The review engine changes',
}

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  detail: string
  at: string
  to?: string
  for: UserId[] | 'all'
}

export const seedNotifications: AppNotification[] = [
  { id: 'N-1', kind: 'engine', title: 'Reviews updated with new rules', detail: '15 drafts re-checked; obligation register built from 17 signed contracts', at: '28 Sep, 09:00', to: '#/register', for: 'all' },
  { id: 'N-2', kind: 'ready', title: 'Harrington Health MSA + BAA, due 1 Oct', detail: 'Dhaval · $210k · signed NDA forbids PHI before a BAA', at: '28 Sep, 09:00', to: '#/review/C-023', for: ['kd', 'dhaval'] },
  { id: 'N-3', kind: 'ready', title: 'FinServe "mutual" NDA, wanted before 1 Oct', detail: 'One-way terms and a non-compete covering Trustline and PayTrack', at: '28 Sep, 09:00', to: '#/review/C-036', for: ['kd'] },
  { id: 'N-4', kind: 'ready', title: 'Lakeshore Grocers, due 3 Oct', detail: "Rate card triggers Crestline's best-price promise", at: '28 Sep, 09:00', to: '#/review/C-026', for: ['kd', 'jay'] },
  { id: 'N-5', kind: 'ready', title: 'Gulf Crown Hotels, due 10 Oct', detail: "Blocked by Al Noor's GCC hospitality non-compete (to 14 Sep 2029)", at: '28 Sep, 09:00', to: '#/review/C-025', for: ['kd', 'bhavin'] },
  { id: 'N-6', kind: 'questions', title: 'Question for you: Al Noor consent for BlueOrchid', detail: 'Dubai and Muscat properties are in scope', at: '28 Sep, 09:00', to: '#/review/C-027', for: ['jay'] },
  { id: 'N-7', kind: 'questions', title: 'Question for you: PipeKit ownership', detail: 'Rheinwerk asks AtliQ to warrant sole ownership', at: '28 Sep, 09:00', to: '#/review/C-028', for: ['bhavin', 'kd'] },
  { id: 'N-8', kind: 'delegation', title: 'Nobody is covering approvals', detail: 'Every decision waits for Karandeep. Consider delegating routine NDAs', at: '28 Sep, 09:00', to: '#/team', for: ['kd'] },
]

/* ----------------------------- G13/G14 — learning cautiously ----------------------------- */

export interface PendingPrecedent {
  id: string
  key: string
  clauseType: string
  counterparty: string
  contract: string
  outcome: string
  label: 'standard' | 'exception'
  by: UserId
  at: string
  status: 'pending' | 'approved'
}

/* ----------------------------- G12 — remember (per viewer) ----------------------------- */

/** Browser-local convenience state. Wrapped in try/catch — storage can be blocked. */
export function usePersistent<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return initial
      const parsed = JSON.parse(raw)
      // Merge objects so new settings keys get their defaults after an upgrade.
      const isObj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x)
      return (isObj(initial) && isObj(parsed) ? { ...(initial as object), ...parsed } : parsed) as T
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage unavailable — keep in memory only */
    }
  }, [key, value])
  return [value, setValue]
}

export const sevRank = (s: Severity) => ({ high: 3, medium: 2, unknown: 1, low: 0 })[s]
