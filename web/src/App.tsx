import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import {
  blockReasons,
  severityLabel,
  users,
  visibleTo,
  type AuditEntry,
  type AuditKind,
  type Contract,
  type ContractStatus,
  type Delegation,
  type Finding,
  type HumanDecision,
  type Obligation,
  type Precedent,
  type ReviewerMark,
  type Severity,
  type UserId,
} from './data'
import { Sidebar, Topbar, type View } from './shell'
import { Banner, Button, Card, EmptyState } from './ui'
import { api, setApiUser, waitForJob } from './api'

/** Set at build time for the hosted web-only demo (vercel.json): no review server, sample data only. */
const HOSTED_DEMO = import.meta.env.VITE_HOSTED_DEMO === '1'
/** Built to call a hosted API (VITE_API_URL), e.g. on Render's free plan, which sleeps when idle. */
const HOSTED_API = Boolean(import.meta.env.VITE_API_URL)

interface OfflineSeed {
  asOf: string
  contracts: Contract[]
  obligations: Obligation[]
  precedents: Precedent[]
  delegations: Delegation[]
  audit: AuditEntry[]
}
import Overview from './Overview'
import Review, { type ReviewHax, type Tab } from './Review'
import { AuditLog, PrecedentSearch, Queue, Register, Submit, Team, type QueueFilter, type SubmitPrefill } from './pages'
import { SettingsPage } from './Settings'
import { AboutDialog, ConfirmDialog, ShortcutsDialog, Toasts, type ConfirmRequest, type ToastItem } from './overlays'
import {
  CURRENT_RULES,
  defaultSettings,
  seedNotifications,
  usePersistent,
  type AppNotification,
  type PendingPrecedent,
  type Settings,
} from './hax'

function stamp() {
  return new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const VIEWS: View[] = ['overview', 'reviews', 'register', 'precedent', 'audit', 'team', 'submit', 'review', 'settings']

/** Hash routes: #/reviews, #/review/C-2041, #/team … Deep-linkable and back-button friendly. */
function parseHash(): { view: View; id?: string } {
  const [, v, id] = window.location.hash.split('/')
  return VIEWS.includes(v as View) ? { view: v as View, id } : { view: 'overview' }
}

function go(v: View, id?: string) {
  window.location.hash = id ? `/${v}/${id}` : `/${v}`
}

/** G12 — per-viewer conveniences remembered in this browser. */
const initialPrefs = {
  queueFilter: 'open' as QueueFilter,
  tabs: {} as Record<string, Tab>,
  recent: [] as string[],
  read: [] as string[],
}

/** G16 — what happens next, shown before high-impact status changes. */
const STATUS_CONFIRM: Partial<Record<ContractStatus, Omit<ConfirmRequest, 'onConfirm'>>> = {
  'Ready to sign': {
    title: 'Approve for signature?',
    consequences: [
      'Status becomes “Ready to sign” and Karandeep is asked to sign.',
      'Findings, decisions and reviewer notes are frozen in the audit trail.',
      'Nothing is signed by the system; signature happens outside it.',
    ],
    confirmLabel: 'Approve for signature',
    tone: 'success',
  },
  Signed: {
    title: 'Record the signature?',
    consequences: [
      'The review becomes read-only.',
      'Approved obligations are queued for the register. They will block conflicting deals until they expire.',
      'Make sure the signed copy matches the version reviewed here.',
    ],
    confirmLabel: 'Record signature',
    tone: 'success',
  },
  Rejected: {
    title: 'Reject this contract?',
    consequences: [
      'The review closes and becomes read-only.',
      'Open questions are withdrawn. Nothing is added to the obligation register.',
      'You can still find it under Closed in Contract reviews.',
    ],
    confirmLabel: 'Reject contract',
    tone: 'danger',
  },
  'With counsel': {
    title: 'Escalate to external counsel?',
    consequences: [
      'Status becomes “With counsel”.',
      'Nothing is sent automatically. Share the flagged clauses with counsel yourself.',
      'Counsel never gets access to this system. External counsel is billed separately.',
    ],
    confirmLabel: 'Escalate',
  },
}

export default function App() {
  const initial = parseHash()
  const [view, setView] = useState<View>(initial.view)
  const [activeId, setActiveId] = useState(initial.id ?? 'C-2041')
  const [data, setData] = useState<Contract[]>([])
  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [user, setUser] = useState<UserId>('kd')
  const [navOpen, setNavOpen] = useState(false)
  const [query, setQuery] = useState('')

  // HAX state
  const [settings, setSettings] = usePersistent<Settings>('atliq.settings', defaultSettings)
  const [prefs, setPrefs] = usePersistent('atliq.prefs', initialPrefs)
  const [notifications, setNotifications] = useState<AppNotification[]>(seedNotifications)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [pending, setPending] = useState<PendingPrecedent[]>([])
  const [saved, setSaved] = useState<Record<string, 'standard' | 'exception' | 'skip'>>({})
  const [prefill, setPrefill] = useState<SubmitPrefill | undefined>()

  // Backend state. `online` is null while loading; false means the API is unreachable and the
  // app falls back to the bundled sample data (changes then live only in this tab).
  const [online, setOnline] = useState<boolean | null>(null)
  const [ai, setAi] = useState<'claude' | 'rules'>('rules')
  const [serverHidden, setServerHidden] = useState(0)
  const [obligations, setObligations] = useState<Obligation[]>([])
  const [precedents, setPrecedents] = useState<Precedent[]>([])

  const load = useCallback(async (u: UserId) => {
    setApiUser(u)
    try {
      if (HOSTED_DEMO) throw new Error('hosted demo: no review server')
      const b = await api.bootstrap()
      setData(b.contracts)
      setDelegations(b.delegations)
      setAudit(b.audit)
      setObligations(b.obligations)
      setPrecedents(b.precedents)
      setPending(b.pending)
      setServerHidden(b.hidden)
      setAi(b.ai)
      setOnline(true)
    } catch {
      // Offline: load the same dataset the API serves (copied to src/seed.json), lazily so it
      // isn't in the main bundle.
      const seed = (await import('./seed.json')).default as unknown as OfflineSeed
      setData(seed.contracts)
      setDelegations(seed.delegations)
      setAudit(seed.audit)
      setObligations(seed.obligations)
      setPrecedents(seed.precedents)
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    void load(user)
  }, [user, load])

  const me = users[user].name
  const log = (action: string, detail: string, kind: AuditKind = 'human', actor = me) =>
    setAudit((a) => [{ id: `A-${Date.now()}-${a.length}`, at: stamp(), actor, action, detail, kind }, ...a])

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback((text: string, action?: ToastItem['action']) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
  }, [])

  // FR-18 — role-based visibility
  const visible = useMemo(() => data.filter((c) => visibleTo(c, user)), [data, user])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? visible.filter((c) => [c.name, c.counterparty, c.id, c.docType].join(' ').toLowerCase().includes(q)) : visible
  }, [visible, query])
  const active = data.find((c) => c.id === activeId)
  const canSeeActive = active && visibleTo(active, user)

  // Online, contracts this user may not see are never sent to the browser. Ask the server
  // whether a missing one is forbidden (403) or genuinely missing (404) so the message is right.
  const [forbidden, setForbidden] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (view !== 'review' || active || !online || activeId in forbidden) return
    api
      .contract(activeId)
      .then((c) => setData((d) => [c, ...d]))
      .catch((e: { status?: number }) => setForbidden((f) => ({ ...f, [activeId]: e.status === 403 })))
  }, [view, active, online, activeId, forbidden])
  useEffect(() => setForbidden({}), [user])
  const deniedHere = !!active || forbidden[activeId]
  const badge = visible.filter((c) => !['Signed', 'Rejected'].includes(c.status) && blockReasons(c).length > 0).length
  const recent = prefs.recent.map((id) => visible.find((c) => c.id === id)).filter((c): c is Contract => !!c)

  // G3 / G17 — notifications for this viewer, filtered by their settings
  const myNotifications = notifications.filter((n) => (n.for === 'all' || n.for.includes(user)) && settings.notify[n.kind])
  const unread = new Set(myNotifications.filter((n) => !prefs.read.includes(`${user}:${n.id}`)).map((n) => n.id))
  const markRead = (ids: string[]) => setPrefs((p) => ({ ...p, read: [...new Set([...p.read, ...ids.map((i) => `${user}:${i}`)])] }))

  const patch = (id: string, fn: (c: Contract) => Contract) => setData((p) => p.map((c) => (c.id === id ? fn(c) : c)))
  const patchFinding = (fid: string, fn: (f: Finding) => Finding) =>
    patch(activeId, (c) => ({ ...c, findings: c.findings.map((f) => (f.id === fid ? fn(f) : f)) }))
  const findingOf = (fid: string) => active?.findings.find((f) => f.id === fid)

  const refreshAudit = () => {
    if (online) api.audit().then(setAudit).catch(() => {})
  }
  const replaceContract = (c: Contract) => setData((d) => (d.some((x) => x.id === c.id) ? d.map((x) => (x.id === c.id ? c : x)) : [c, ...d]))

  /**
   * Optimistic update: the change is applied locally first, then sent to the server. The server's
   * copy replaces ours; on error we roll back and say why. Offline, the local change simply stays.
   */
  const sync = (call: () => Promise<Contract>, rollback: Contract[], key?: string) => {
    if (!online) return
    const done = call()
      .then((c) => {
        replaceContract(c)
        refreshAudit()
      })
      .catch((e: Error) => {
        setData(rollback)
        toast(e.message)
      })
    if (key) inFlight.current.set(key, done)
  }
  /** The latest decision/wording request per finding ("C-023/F-2"). Saving the outcome as precedent
   *  waits for it: on a slow connection the save could otherwise reach the server first. */
  const inFlight = useRef(new Map<string, Promise<void>>())

  /** G8 — every reversible change offers Undo for a few seconds. `server` re-sends the old values. */
  const undoAction = (what: string, server?: () => Promise<Contract>): ToastItem['action'] => {
    const prev = data
    return {
      label: 'Undo',
      run: () => {
        setData(prev)
        log('Undone', what)
        if (server) sync(server, prev)
      },
    }
  }

  // G12 — any route to a review (list, link, notification, back button) counts as "viewed".
  const remember = useCallback(
    (id: string) => setPrefs((p) => (p.recent[0] === id ? p : { ...p, recent: [id, ...p.recent.filter((x) => x !== id)].slice(0, 3) })),
    [setPrefs],
  )

  useEffect(() => {
    const first = parseHash()
    if (first.view === 'review' && first.id) remember(first.id)
    const onHash = () => {
      const r = parseHash()
      setView(r.view)
      if (r.id) setActiveId(r.id)
      if (r.view === 'review' && r.id) remember(r.id)
      if (r.view !== 'submit') setPrefill(undefined)
      setNavOpen(false)
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [remember])

  // G7 — global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable || document.querySelector('[aria-modal]')) return
      if (e.key === 'n') {
        e.preventDefault()
        go('submit')
      } else if (e.key === '/') {
        e.preventDefault()
        document.getElementById('global-search')?.focus()
      } else if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  function open(id: string) {
    if (online) {
      // The server logs the retrieval (FR-18) and returns the freshest copy.
      api.contract(id).then((c) => {
        replaceContract(c)
        refreshAudit()
      }).catch(() => {})
    } else {
      log('Opened review', `${id}: AI review, evidence and precedent retrieved (permission-filtered).`, 'retrieval')
    }
    go('review', id)
  }

  function decide(findingId: string, d: HumanDecision) {
    const f = findingOf(findingId)
    const cid = activeId
    const prev = data
    const undo = undoAction(`${cid} ${findingId} decision`, () =>
      api.patchFinding(cid, findingId, f?.dismissReason !== undefined ? { dismissReason: f.dismissReason } : { decision: f?.decision ?? 'pending' }),
    )
    patchFinding(findingId, (x) => ({ ...x, decision: d, decidedBy: d === 'pending' ? undefined : user, dismissReason: undefined }))
    log(d === 'pending' ? 'Finding decision cleared' : `Finding ${d}`, `${cid} ${findingId}`)
    sync(() => api.patchFinding(cid, findingId, { decision: d }), prev, `${cid}/${findingId}`)
    if (d !== 'pending' && f) toast(`§${f.citation.section} marked ${d}`, undo)
  }

  function mark(findingId: string, m: ReviewerMark) {
    const prev = data
    patchFinding(findingId, (f) => ({ ...f, marks: [...f.marks, m] }))
    sync(() => api.patchFinding(activeId, findingId, { mark: { verdict: m.verdict, regradeTo: m.regradeTo, comment: m.comment } }), prev)
    log(
      m.verdict === 'regrade' ? `Re-graded to ${m.regradeTo}` : m.verdict === 'agree' ? 'Agreed with AI finding' : 'Reviewer comment',
      `${activeId} ${findingId} as ${m.as} reviewer${m.comment ? `: “${m.comment}”` : ''}`,
    )
  }

  function setStatus(s: ContractStatus, note: string) {
    const id = activeId
    const before = active?.status
    const run = () => {
      const prev = data
      const undo = s === 'Signed' || !before ? undefined : undoAction(`${id} status`, () => api.setStatus(id, before, 'Undone'))
      patch(id, (c) => ({ ...c, status: s }))
      sync(() => api.setStatus(id, s, note), prev)
      if (s === 'Signed' && online) setTimeout(() => api.obligations().then(setObligations).catch(() => {}), 400)
      log(note, `${id} → ${s}`)
      if (s === 'Signed') log('Obligations queued for register', `${id}: approved obligations only, pending human confirmation.`, 'system', 'System')
      toast(`${active?.counterparty ?? id}: ${s.toLowerCase()}`, undo)
    }
    const c = STATUS_CONFIRM[s]
    if (c) setConfirm({ ...c, onConfirm: run })
    else run()
  }

  function resolve(missingId: string) {
    const prev = data
    patch(activeId, (c) => ({ ...c, missingInfo: c.missingInfo.map((m) => (m.id === missingId ? { ...m, resolved: true } : m)) }))
    sync(() => api.resolve(activeId, missingId), prev)
    log('Question answered', `${activeId} ${missingId}`)
  }

  function delegate(d: Omit<Delegation, 'id' | 'created' | 'active'>) {
    const scope = d.scope === 'all-routine' ? 'all routine contracts' : d.scope.join(', ')
    setConfirm({
      title: `Delegate approval to ${users[d.to].name}?`,
      consequences: [
        `${users[d.to].name} can approve ${scope} until ${d.expires}.`,
        'Signing stays with Karandeep.',
        'Recorded in the audit log. You can revoke it at any time.',
      ],
      confirmLabel: 'Delegate',
      onConfirm: () => {
        if (online) {
          api
            .delegate({ to: d.to, scope: d.scope, expires: d.expires })
            .then((ds) => {
              setDelegations(ds)
              refreshAudit()
              toast(`${users[d.to].name} can now approve ${scope}`)
            })
            .catch((e: Error) => toast(e.message))
          return
        }
        const id = `D-${String(delegations.length + 7).padStart(2, '0')}`
        const created = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        setDelegations((ds) => [{ ...d, id, created, active: true }, ...ds])
        log('Delegation granted', `${id}: ${users[d.to].name}, review and approval of ${scope}, expires ${d.expires}. Signature retained by KD.`, 'delegation')
        toast(`${users[d.to].name} can now approve ${scope}`)
      },
    })
  }

  function revoke(id: string) {
    const d = delegations.find((x) => x.id === id)
    if (!d) return
    setConfirm({
      title: `Revoke ${users[d.to].name}'s delegation?`,
      consequences: [`${users[d.to].name} loses approval rights immediately.`, 'Approvals they were covering go back to Karandeep.'],
      confirmLabel: 'Revoke',
      tone: 'danger',
      onConfirm: () => {
        if (online) {
          api
            .revoke(id)
            .then((ds) => {
              setDelegations(ds)
              refreshAudit()
              toast(`Delegation ${id} revoked`)
            })
            .catch((e: Error) => toast(e.message))
          return
        }
        setDelegations((ds) => ds.map((x) => (x.id === id ? { ...x, active: false } : x)))
        log('Delegation revoked', id, 'delegation')
        toast(`Delegation ${id} revoked`)
      },
    })
  }

  /* --------------------------- HAX handlers for the review --------------------------- */

  function rerun() {
    const id = activeId
    if (online) {
      api
        .rerun(id)
        .then(async (r) => {
          if (r.contract) {
            replaceContract(r.contract)
            toast(`Re-run with ${CURRENT_RULES}: no changes to findings`)
          } else if (r.jobId) {
            toast('Re-running the review…')
            const job = await waitForJob(r.jobId, () => {})
            if (job.status === 'done') {
              replaceContract(await api.contract(id))
              toast(`Re-run with ${CURRENT_RULES} complete`)
            } else toast(job.error ?? 'Re-run failed')
          }
          refreshAudit()
        })
        .catch((e: Error) => toast(e.message))
      return
    }
    patch(id, (c) => ({ ...c, audit: { ...c.audit, rulesVersion: CURRENT_RULES, completedAt: stamp(), durationSeconds: c.audit.durationSeconds } }))
    log('Review re-run', `${id} with ${CURRENT_RULES}. Findings unchanged (no Saudi or DIFC terms).`, 'ai', 'System')
    toast(`Re-run with ${CURRENT_RULES}: no changes to findings`)
  }

  const haxActions: ReviewHax = {
    settings,
    initialTab: prefs.tabs[activeId],
    onTab: (t) => setPrefs((p) => ({ ...p, tabs: { ...p.tabs, [activeId]: t } })),
    saved,
    onFeedback: (fid, fb) => {
      const prev = data
      patchFinding(fid, (f) => ({ ...f, feedback: fb }))
      sync(() => api.patchFinding(activeId, fid, { feedback: fb ? { useful: fb.useful, reason: fb.reason } : null }), prev)
      if (fb) log('Finding feedback', `${activeId} ${fid}: ${fb.useful ? 'helpful' : `not helpful: ${fb.reason}`}`)
    },
    onWordingFeedback: (fid, v) => {
      const prev = data
      patchFinding(fid, (f) => ({ ...f, wordingFeedback: v }))
      sync(() => api.patchFinding(activeId, fid, { wordingFeedback: v }), prev)
      log('Suggested-wording feedback', `${activeId} ${fid}: ${v}`)
    },
    onDismiss: (fid, reason) => {
      const f = findingOf(fid)
      const cid = activeId
      const prev = data
      const undo = undoAction(`${cid} ${fid} dismissal`, () => api.patchFinding(cid, fid, { decision: f?.decision ?? 'pending' }))
      patchFinding(fid, (x) => ({ ...x, decision: 'rejected', decidedBy: user, dismissReason: reason ?? '' }))
      sync(() => api.patchFinding(cid, fid, { dismissReason: reason ?? '' }), prev)
      log('Dismissed as not an issue', `${activeId} ${fid}${reason ? `: ${reason}` : ''}`)
      toast(`§${f?.citation.section} marked not an issue`, undo)
    },
    onEditWording: (fid, text) => {
      const cid = activeId
      const pf = findingOf(fid)
      const prev = data
      const undo = undoAction(`${cid} ${fid} wording`, () =>
        api.patchFinding(cid, fid, { editedFallback: pf?.editedFallback?.text ?? null, decision: pf?.decision ?? 'pending' }),
      )
      patchFinding(fid, (f) => ({ ...f, editedFallback: { text, by: user }, decision: 'modified', decidedBy: user }))
      sync(() => api.patchFinding(cid, fid, { editedFallback: text }), prev, `${cid}/${fid}`)
      log('Suggested wording edited', `${activeId} ${fid}: AI original kept`)
      toast('Wording saved. The AI original is kept.', undo)
    },
    onSavePrecedent: (fid, label) => {
      const c = active
      const f = findingOf(fid)
      if (!c || !f) return
      const key = `${c.id}/${fid}`
      setSaved((s) => ({ ...s, [key]: label }))
      if (label === 'skip') return
      const item: PendingPrecedent = {
        id: `PP-${Date.now()}`,
        key,
        clauseType: f.category,
        counterparty: c.counterparty,
        contract: c.name,
        outcome: f.editedFallback?.text ?? f.suggestedFallback?.text ?? f.clauseTitle,
        label,
        by: user,
        at: stamp(),
        status: 'pending',
      }
      const announce = () => {
        log('Outcome saved as pending precedent', `${key} as ${label === 'standard' ? 'standard position' : 'one-off exception'}, awaiting KD approval`)
        if (user !== 'kd')
          setNotifications((n) => [
            { id: `N-${Date.now()}`, kind: 'questions', title: 'Precedent waiting for your approval', detail: `${c.counterparty} · saved by ${me}`, at: stamp(), to: '#/precedent', for: ['kd'] },
            ...n,
          ])
        toast('Saved. Waiting for Karandeep’s approval', { label: 'View', run: () => go('precedent') })
      }
      if (online)
        (inFlight.current.get(key) ?? Promise.resolve())
          .then(() => api.savePending(c.id, fid, label))
          .then((srv) => {
            setPending((p) => [srv, ...p])
            refreshAudit()
            announce()
          })
          .catch((e: Error) => {
            // Not saved: bring the "Remember this outcome?" choice back and say why.
            setSaved((s) => {
              const rest = { ...s }
              delete rest[key]
              return rest
            })
            toast(e.message)
          })
      else {
        setPending((p) => [item, ...p])
        announce()
      }
    },
    onRegrade: (fid, s: Severity) => {
      const f = findingOf(fid)
      if (!f) return
      const cid = activeId
      const prev = data
      const undo = undoAction(`${cid} ${fid} severity`, () => api.patchFinding(cid, fid, { severityOverride: f.severityOverride?.to ?? null }))
      patchFinding(fid, (x) => ({ ...x, severityOverride: s === x.severity ? undefined : { to: s, by: user } }))
      sync(() => api.patchFinding(cid, fid, { severityOverride: s }), prev)
      log('Severity corrected', `${activeId} ${fid}: AI ${f.severity} → ${s}`)
      toast(`§${f.citation.section} set to ${severityLabel[s].toLowerCase()}`, undo)
    },
    onConfirmDetails: (v) => {
      const c = active
      if (!c) return
      const changed = !!v && (v.docType !== c.docType || v.atliqRole !== c.atliqRole || v.entity !== c.entity || v.country !== c.country)
      const prev = data
      patch(c.id, (x) => ({ ...x, ...(v ?? {}), detailsCheckedBy: { by: user, corrected: changed } }))
      sync(() => api.details(c.id, changed && v ? v : {}), prev)
      log(changed ? 'AI-detected details corrected' : 'AI-detected details confirmed', `${c.id}${changed && v ? `: ${v.docType}, ${v.atliqRole}, ${v.entity}, ${v.country}` : ''}`)
      if (changed) toast(online ? 'Details corrected. The entity rule was re-checked.' : 'Details corrected')
      else toast('Thanks, details confirmed')
    },
    onRerun: rerun,
    onUploadRevision: () => {
      const c = active
      if (!c) return
      setPrefill({ fromId: c.id, counterparty: c.counterparty, country: c.country, docType: c.docType, direction: c.direction })
      go('submit')
    },
  }

  const submitFinished = useCallback(
    (name: string, contractId: string | null) => {
      const to = contractId ? `#/review/${contractId}` : '#/reviews'
      setNotifications((n) => [
        { id: `N-${Date.now()}`, kind: 'ready', title: `${name} is ready`, detail: contractId ? `Review ${contractId}` : 'Offline demo: opens the sample queue', at: 'Just now', to, for: [user] },
        ...n,
      ])
      if (contractId)
        api
          .contract(contractId)
          .then((c) => {
            setData((d) => [c, ...d.filter((x) => x.id !== c.id)])
            api.audit().then(setAudit).catch(() => {})
          })
          .catch(() => {})
      toast(`Review of ${name} is ready`, { label: 'Open', run: () => (contractId ? go('review', contractId) : go('reviews')) })
    },
    [user, toast],
  )

  function approvePrecedent(id: string) {
    if (online) {
      api
        .approvePending(id)
        .then((list) => {
          setPending(list)
          api.precedents().then(setPrecedents).catch(() => {})
          refreshAudit()
          toast('Approved. Future reviews will use this precedent')
        })
        .catch((e: Error) => toast(e.message))
      return
    }
    const p = pending.find((x) => x.id === id)
    if (p)
      setPrecedents((ps) => [
        { id: `P-${Date.now()}`, clauseType: p.clauseType, counterparty: p.counterparty, contract: p.contract, date: stamp(), asked: 'see review', outcome: p.outcome, label: p.label, context: `Saved from a review by ${users[p.by].name}, approved by Karandeep` },
        ...ps,
      ])
    setPending((p) => p.map((x) => (x.id === id ? { ...x, status: 'approved' } : x)))
    log('Precedent approved', `${id}: now used in future reviews`)
    toast('Approved. Future reviews will use this precedent')
  }
  function discardPrecedent(id: string) {
    if (online) {
      api
        .discardPending(id)
        .then((list) => {
          setPending(list)
          refreshAudit()
          toast('Discarded. Nothing was learned')
        })
        .catch((e: Error) => toast(e.message))
      return
    }
    setPending((p) => p.filter((x) => x.id !== id))
    log('Precedent discarded', id)
    toast('Discarded. Nothing was learned')
  }

  function resetPrefs() {
    setConfirm({
      title: 'Reset remembered preferences?',
      consequences: [
        'Clears recently viewed, saved filters, last-opened tabs and read notifications in this browser.',
        'Settings toggles, contract decisions and the audit log are not affected.',
      ],
      confirmLabel: 'Reset',
      onConfirm: () => {
        setPrefs(initialPrefs)
        toast('Preferences reset')
      },
    })
  }

  return (
    <div className="min-h-full">
      <Sidebar view={view} setView={go} open={navOpen} badge={badge} />
      {navOpen && <div onClick={() => setNavOpen(false)} className="fixed inset-0 z-20 bg-[#0f2744]/40 lg:hidden" aria-hidden />}

      <div className="lg:pl-[260px]">
        <Topbar
          onMenu={() => setNavOpen(true)}
          user={user}
          setUser={setUser}
          query={query}
          setQuery={(q) => {
            setQuery(q)
            if (q && view !== 'reviews') go('reviews')
          }}
          notifications={myNotifications}
          unread={unread}
          onRead={(id) => markRead([id])}
          onReadAll={() => markRead(myNotifications.map((n) => n.id))}
          onHelp={() => setAboutOpen(true)}
          recent={recent.map((c) => ({ id: c.id, title: c.counterparty, sub: `${c.docType} · ${c.status}` }))}
        />
        <main className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-8">
          {online === false && (
            <div className="mb-6">
              {HOSTED_DEMO ? (
                <Banner tone="info" title="Demo version with sample contracts">
                  This hosted demo runs in your browser on the capstone sample data. You can explore every review and try the
                  workflow, but changes aren't saved and no new AI review runs.
                </Banner>
              ) : (
                <Banner
                  tone="warn"
                  title={HOSTED_API ? 'The review server is waking up' : "Offline demo: the review server isn't running"}
                  action={
                    <Button size="sm" onClick={() => load(user)}>
                      Retry
                    </Button>
                  }
                >
                  {HOSTED_API ? (
                    <>It sleeps when nobody has used it for a while and takes about a minute to start. Meanwhile you're seeing sample data and changes won't be saved. Try again in a minute.</>
                  ) : (
                    <>
                      You're seeing sample data and changes won't be saved. Start it with <code className="rounded bg-white/70 px-1">uv run uvicorn app.main:app --port 8000</code> in
                      Project/api.
                    </>
                  )}
                </Banner>
              )}
            </div>
          )}
          {view === 'overview' && (
            <Overview
              data={visible}
              user={user}
              delegations={delegations}
              onOpen={open}
              onNew={() => go('submit')}
              onAll={() => go('reviews')}
              onTeam={() => go('team')}
              onRegister={() => go('register')}
              obligations={obligations}
            />
          )}
          {view === 'reviews' && (
            <Queue
              data={filtered}
              hidden={online ? serverHidden : data.length - visible.length}
              user={user}
              delegations={delegations}
              query={query}
              clearQuery={() => setQuery('')}
              onOpen={open}
              filter={prefs.queueFilter}
              setFilter={(f) => setPrefs((p) => ({ ...p, queueFilter: f }))}
            />
          )}
          {view === 'review' &&
            (canSeeActive ? (
              <Review
                key={active.id}
                c={active}
                user={user}
                delegations={delegations}
                audit={audit}
                onDecide={decide}
                onMark={mark}
                onStatus={setStatus}
                onResolve={resolve}
                onBack={() => go('reviews')}
                hax={haxActions}
              />
            ) : (
              <Card>
                <EmptyState
                  icon={<Lock size={20} />}
                  title={deniedHere ? "You don't have access to this contract" : 'Contract not found'}
                  action={<Button onClick={() => go('reviews')}>Back to your reviews</Button>}
                >
                  {deniedHere
                    ? 'It is restricted to its assigned reviewers and Karandeep. Ask KD to add you as a reviewer.'
                    : 'The link may be wrong, or the contract was removed.'}
                </EmptyState>
              </Card>
            ))}
          {view === 'register' && <Register obligations={obligations} />}
          {view === 'precedent' && (
            <PrecedentSearch precedents={precedents} pending={pending} canApprove={user === 'kd'} onApprove={approvePrecedent} onDiscard={discardPrecedent} />
          )}
          {view === 'audit' && <AuditLog audit={audit} />}
          {view === 'team' && (
            <Team user={user} data={data} delegations={delegations} onDelegate={delegate} onRevoke={revoke} />
          )}
          {view === 'submit' && (
            <Submit user={user} online={!!online} prefill={prefill} onFinished={submitFinished} onDone={() => go('reviews')} onOpen={(id) => go('review', id)} />
          )}
          {view === 'settings' && (
            <SettingsPage settings={settings} setSettings={setSettings} user={user} onReset={resetPrefs} analyzer={online === false ? 'offline' : ai} />
          )}
        </main>
      </div>

      <ConfirmDialog req={confirm} onClose={() => setConfirm(null)} />
      <AboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        onShortcuts={() => {
          setAboutOpen(false)
          setShortcutsOpen(true)
        }}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Toasts items={toasts} dismiss={dismissToast} />
    </div>
  )
}
