import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ShieldAlert,
  Tag as TagIcon,
  GitBranch,
  Info,
  Check,
  X,
  ChevronDown,
  ChevronLeft,
  MoreHorizontal,
  Lock,
  Copy,
  MessageSquarePlus,
  Inbox,
  Users,
  ThumbsUp,
  ThumbsDown,
  Pencil,
  RefreshCw,
  Upload,
  Sparkles,
} from 'lucide-react'
import {
  actionLabel,
  approverOf,
  canApprove,
  coverage,
  dispositionLabel,
  liveConflicts,
  openHighSeverity,
  reviewerRole,
  severityLabel,
  users,
  type AuditEntry,
  type Contract,
  type ContractStatus,
  type DealContext,
  type Delegation,
  type Finding,
  type HumanDecision,
  type ReviewerMark,
  type Severity,
  type UserId,
} from './data'
import {
  Avatar,
  Banner,
  Button,
  Card,
  Confidence,
  EmptyState,
  Evidence,
  Field,
  LabelPill,
  ObligationPill,
  Segmented,
  SeverityPill,
  StatePill,
  Tag,
  inputCls,
  sevDot,
  stateTone,
} from './ui'
import { CURRENT_RULES, DETECT_CONF, DRIVERS, daysFromToday, engineChangelog, type Settings } from './hax'

export type Tab = 'findings' | 'conflicts' | 'checks' | 'questions' | 'clauses' | 'activity'
/** HAX actions and preferences passed down from App. */
export interface ReviewHax {
  settings: Settings
  initialTab?: Tab
  onTab: (t: Tab) => void
  saved: Record<string, 'standard' | 'exception' | 'skip'>
  onFeedback: (fid: string, fb: Finding['feedback'] | undefined) => void
  onWordingFeedback: (fid: string, v: NonNullable<Finding['wordingFeedback']>) => void
  onDismiss: (fid: string, reason?: string) => void
  onEditWording: (fid: string, text: string) => void
  onSavePrecedent: (fid: string, label: 'standard' | 'exception' | 'skip') => void
  onRegrade: (fid: string, s: Severity) => void
  onConfirmDetails: (v?: Pick<Contract, 'docType' | 'atliqRole' | 'entity' | 'country'>) => void
  onRerun: () => void
  onUploadRevision: () => void
}

const SEV_ORDER: Severity[] = ['high', 'unknown', 'medium', 'low']
const SEV_HEADING: Record<Severity, string> = {
  high: 'High severity',
  unknown: 'Needs your judgement',
  medium: 'Medium severity',
  low: 'Low severity',
}

const VERDICT_TONE: Record<Severity, string> = {
  high: 'text-risk-high',
  medium: 'text-risk-med',
  low: 'text-risk-low',
  unknown: 'text-ink-700',
}
const STRIPE: Record<Severity, string> = {
  high: 'before:bg-risk-high',
  medium: 'before:bg-risk-med',
  low: 'before:bg-risk-low',
  unknown: 'before:bg-ink-300',
}

export default function Review({
  c,
  user,
  delegations,
  audit,
  onDecide,
  onMark,
  onStatus,
  onResolve,
  onBack,
  hax,
}: {
  c: Contract
  user: UserId
  delegations: Delegation[]
  audit: AuditEntry[]
  onDecide: (findingId: string, d: HumanDecision) => void
  onMark: (findingId: string, m: ReviewerMark) => void
  onStatus: (s: ContractStatus, note: string) => void
  onResolve: (missingId: string) => void
  onBack: () => void
  hax: ReviewHax
}) {
  const [tab, setTabState] = useState<Tab>(hax.initialTab ?? 'findings')
  const setTab = (t: Tab) => {
    setTabState(t)
    hax.onTab(t)
  }
  const [showLowNow, setShowLowNow] = useState(false)
  const [openFinding, setOpenFinding] = useState<string | null>(
    () => c.findings.find((f) => f.severity === 'high' && f.decision === 'pending')?.id ?? c.findings[0]?.id ?? null,
  )
  const tabsRef = useRef<HTMLDivElement>(null)
  const verdictRef = useRef<HTMLElement>(null)
  // The tab bar repeats the primary action only once the verdict card has scrolled away.
  const [verdictVisible, setVerdictVisible] = useState(true)
  useEffect(() => {
    const el = verdictRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVerdictVisible(e.isIntersecting), { rootMargin: '-64px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const cov = coverage(c)
  const approver = approverOf(c, delegations)
  const mayApprove = canApprove(c, user, delegations)
  const myRole = reviewerRole(c, user)
  const closed = c.status === 'Signed' || c.status === 'Rejected'
  const state = cov.below ? 'insufficient-evidence' : c.state
  const tone = stateTone(state)
  const highs = openHighSeverity(c)
  const live = liveConflicts(c).length
  const openQs = c.missingInfo.filter((m) => !m.resolved)
  const blockingQs = openQs.filter((m) => m.blocking).length
  const pendingFindings = c.findings.filter((f) => f.decision === 'pending').length
  const lowHidden = !hax.settings.showLow && !showLowNow
  const orderKey = SEV_ORDER.flatMap((s) => (s === 'low' && lowHidden ? [] : c.findings.filter((f) => f.severity === s).map((f) => f.id))).join(',')

  // G7 — J / K move between findings.
  useEffect(() => {
    if (tab !== 'findings') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || document.querySelector('[aria-modal]')) return
      if (e.key !== 'j' && e.key !== 'k') return
      const ids = orderKey ? orderKey.split(',') : []
      if (!ids.length) return
      const i = openFinding ? ids.indexOf(openFinding) : -1
      const next = ids[e.key === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)]
      e.preventDefault()
      setOpenFinding(next)
      requestAnimationFrame(() => document.getElementById(`finding-${next}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tab, openFinding, orderKey])

  const gates: { ok: boolean; text: string; tab: Tab }[] = [
    { ok: !cov.below, text: cov.below ? `${cov.notCovered} clauses not examined` : 'Every clause examined', tab: 'clauses' },
    { ok: highs === 0, text: highs ? `${highs} high-severity finding${highs > 1 ? 's' : ''} undecided` : 'High-severity findings decided', tab: 'findings' },
    { ok: live === 0, text: live ? `Conflicts with ${live} live obligation${live > 1 ? 's' : ''}` : 'No live obligation conflicts', tab: 'conflicts' },
    { ok: c.entityCheck.status === 'pass', text: c.entityCheck.status === 'pass' ? 'Correct AtliQ entity' : 'Wrong AtliQ entity named', tab: 'checks' },
    ...(c.family ? [{ ok: !c.family.orphan, text: c.family.orphan ? 'Parent agreement not found' : 'Parent agreement linked', tab: 'checks' as Tab }] : []),
    { ok: blockingQs === 0, text: blockingQs ? `${blockingQs} blocking question${blockingQs > 1 ? 's' : ''} open` : 'No blocking questions', tab: 'questions' },
  ]
  const blocked = gates.some((g) => !g.ok)

  // The recommended next step is the primary action; everything else is secondary.
  const primaryFor: Record<string, [ContractStatus, string]> = {
    'do-not-sign': ['In negotiation', 'Send to negotiation'],
    negotiate: ['In negotiation', 'Send to negotiation'],
    counsel: ['With counsel', 'Escalate to counsel'],
    'internal-confirmation': ['Internal confirmation', 'Request confirmation'],
    'no-verdict': ['Internal confirmation', 'Request clean copy'],
    proceed: ['Ready to sign', 'Approve for signature'],
  }
  const [primaryStatus, primaryLabel] =
    c.status === primaryFor[cov.below ? 'no-verdict' : c.disposition][0]
      ? (['Ready to sign', 'Approve for signature'] as [ContractStatus, string])
      : primaryFor[cov.below ? 'no-verdict' : c.disposition]
  const primaryIsApprove = primaryStatus === 'Ready to sign'

  function goTab(t: Tab) {
    setTab(t)
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const actions: [ContractStatus, string][] = (
    [
      ['In negotiation', 'Send to negotiation'],
      ['Internal confirmation', 'Request internal confirmation'],
      ['With counsel', 'Escalate to counsel'],
    ] as [ContractStatus, string][]
  ).filter(([s]) => s !== primaryStatus)

  const primaryButton =
    !closed && mayApprove ? (
      c.status === 'Ready to sign' ? (
        users[user].canSign ? (
          <Button variant="success" onClick={() => onStatus('Signed', 'Signature recorded; signed copy linked to review')}>
            <Check size={16} /> Record signature
          </Button>
        ) : (
          <Button variant="secondary" disabled>
            Awaiting KD's signature
          </Button>
        )
      ) : (
        <Button
          variant="primary"
          disabled={primaryIsApprove && blocked}
          onClick={() => onStatus(primaryStatus, primaryLabel)}
          title={primaryIsApprove && blocked ? 'Clear every item under "Before signing" first' : undefined}
        >
          {primaryIsApprove && blocked && <Lock size={14} />}
          {primaryLabel}
        </Button>
      )
    ) : null

  return (
    <div className="space-y-6">
      {/* ---------------- header ---------------- */}
      <div>
        <button onClick={onBack} className="-ml-1 mb-3 inline-flex items-center gap-0.5 text-[13px] font-medium text-ink-500 hover:text-ink-900">
          <ChevronLeft size={16} /> Contract reviews
        </button>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-ink-900">{c.counterparty}</h1>
              {c.direction === 'outbound' && <Tag className="bg-brand-50 text-brand-700">AtliQ outbound draft</Tag>}
            </div>
            <p className="mt-0.5 text-[13px] text-ink-500">
              {c.name.split(' - ')[1]?.trim() ?? c.docType} · <span className="text-ink-400">{c.id}</span>
            </p>
            <DealFacts c={c} closed={closed} />
            <DetectedDetails c={c} canEdit={(mayApprove || !!myRole) && !closed} hax={hax} />
          </div>
          <People c={c} user={user} approver={approver.user} delegatedUntil={approver.delegation?.expires} />
        </div>
      </div>

      {/* §10.2 special states — compact, above the verdict */}
      {(c.presentedAs || c.injection || c.family?.orphan) && (
        <div className="space-y-2">
          {c.injection && (
            <Banner tone="danger" title="Hidden instructions found and ignored" icon={<ShieldAlert size={17} />}>
              Page {c.injection.page}: {c.injection.note}
            </Banner>
          )}
          {c.presentedAs && (
            <Banner tone="info" title={`Labelled “${c.presentedAs}” but reviewed in full anyway`} icon={<TagIcon size={16} />}>
              A label never reduces scrutiny. Every clause was examined as if the label were absent.
            </Banner>
          )}
          {c.family?.orphan && (
            <Banner tone="warn" title="Parent agreement not found" icon={<GitBranch size={16} />}>
              {c.family.note}
            </Banner>
          )}
        </div>
      )}

      {/* G18 — reviews made with an older engine say so */}
      {c.audit.rulesVersion !== CURRENT_RULES && !closed && (
        <Banner
          tone="info"
          title={`Reviewed with ${c.audit.rulesVersion}; ${CURRENT_RULES} is now available`}
          icon={<RefreshCw size={16} />}
          action={
            mayApprove ? (
              <Button size="sm" onClick={hax.onRerun}>
                Re-run review
              </Button>
            ) : undefined
          }
        >
          {engineChangelog[0].title}. {engineChangelog[0].affects}
        </Banner>
      )}

      {/* ---------------- verdict ---------------- */}
      <section
        ref={verdictRef}
        className={`relative overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,39,68,0.06)] before:absolute before:inset-y-0 before:left-0 before:w-1 ${STRIPE[tone]}`}
      >
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="p-6 sm:p-7">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-400">AI recommendation</span>
              <StatePill s={state} />
              {c.status !== 'Awaiting review' && <Tag className="bg-slate-100 text-ink-600">{c.status}</Tag>}
            </div>
            <p className={`mt-2 text-[30px] font-bold leading-tight tracking-[-0.02em] ${VERDICT_TONE[tone]}`}>
              {cov.below ? dispositionLabel['no-verdict'] : dispositionLabel[c.disposition]}
            </p>
            <p className="mt-3 max-w-[68ch] text-[15px] leading-[1.65] text-ink-700">{c.summary.replace(/^(Do not sign yet|Negotiable|No overall verdict)\.\s*/, '')}</p>

            <button
              onClick={() => goTab('clauses')}
              className="group mt-5 flex w-full max-w-md items-center gap-3 text-left"
              title="Open the clause list"
            >
              <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                <span className="bg-ink-700" style={{ width: `${cov.pct * 100}%` }} />
              </span>
              <span className="shrink-0 text-[13px] text-ink-600 group-hover:text-ink-900">
                <strong className="font-semibold text-ink-900">
                  {cov.total - cov.notCovered} of {cov.total}
                </strong>{' '}
                clauses examined
              </span>
            </button>

            {!closed && (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                {primaryButton}
                {mayApprove && c.status !== 'Ready to sign' && !primaryIsApprove && (
                  <Button
                    disabled={blocked}
                    onClick={() => onStatus('Ready to sign', 'Approved for signature')}
                    title={blocked ? 'Clear every item under "Before signing" first' : undefined}
                  >
                    {blocked && <Lock size={14} />} Approve for signature
                  </Button>
                )}
                {mayApprove && (
                  <MoreMenu
                    actions={actions}
                    onPick={(s, l) => onStatus(s, l)}
                    onReject={() => onStatus('Rejected', 'Rejected: will not sign')}
                    extra={[
                      { label: 'Upload revised draft', icon: <Upload size={15} />, onClick: hax.onUploadRevision },
                      ...(cov.below || c.audit.rulesVersion !== CURRENT_RULES
                        ? [{ label: 'Re-run review', icon: <RefreshCw size={15} />, onClick: hax.onRerun }]
                        : []),
                    ]}
                  />
                )}
                {!mayApprove && (
                  <p className="text-[13px] text-ink-500">
                    {myRole
                      ? `You're the ${myRole} reviewer: add your assessment on each finding. ${users[approver.user].name} decides.`
                      : `Read-only. ${users[approver.user].name} decides.`}
                  </p>
                )}
              </div>
            )}
            {closed && (
              <p className="mt-6 text-[13px] text-ink-500">
                This contract is <strong className="text-ink-800">{c.status.toLowerCase()}</strong>. The review is kept read-only for the audit record.
              </p>
            )}
          </div>

          {/* Before signing — every gate, passing or not */}
          <aside className="border-t border-slate-100 bg-slate-50/70 p-6 lg:border-l lg:border-t-0">
            <p className="text-[13px] font-semibold text-ink-900">Before signing</p>
            <p className="mt-0.5 text-[12px] text-ink-500">Why the AI suggests “{cov.below ? 'no verdict' : dispositionLabel[c.disposition].toLowerCase()}”</p>
            <ul className="mt-3 space-y-1">
              {gates.map((g) => (
                <li key={g.text}>
                  <button
                    onClick={() => goTab(g.tab)}
                    className="group flex w-full items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-white"
                  >
                    {g.ok ? (
                      <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-risk-low-bg text-risk-low">
                        <Check size={12} strokeWidth={3} />
                      </span>
                    ) : (
                      <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-risk-high text-white">
                        <X size={12} strokeWidth={3} />
                      </span>
                    )}
                    <span className={`flex-1 text-[13px] leading-snug ${g.ok ? 'text-ink-500' : 'font-medium text-ink-900'}`}>{g.text}</span>
                    {!g.ok && <span className="text-[12px] font-medium text-brand-600 opacity-0 group-hover:opacity-100">View</span>}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 flex gap-2 border-t border-slate-200/80 pt-4 text-[12px] leading-relaxed text-ink-500">
              <Info size={14} className="mt-px shrink-0" />
              Reads documents only. Promises made on calls, WhatsApp, Teams or Slack aren't visible, so recall them before deciding.
            </p>
          </aside>
        </div>
      </section>

      {/* ---------------- tabs ---------------- */}
      <div ref={tabsRef} className="sticky top-[64px] z-10 -mx-4 scroll-mt-[64px] bg-canvas/95 px-4 backdrop-blur sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-4 border-b border-slate-200">
          <nav className="-mb-px flex flex-1 gap-1 overflow-x-auto" role="tablist">
            <TabBtn id="findings" cur={tab} set={setTab} label="Findings" count={pendingFindings} alert={highs > 0} />
            <TabBtn id="conflicts" cur={tab} set={setTab} label="Conflicts" count={live || undefined} alert={live > 0} />
            <TabBtn id="checks" cur={tab} set={setTab} label="Entity & counterparty" alert={c.entityCheck.status === 'fail' || !!c.family?.orphan} />
            <TabBtn id="questions" cur={tab} set={setTab} label="Questions" count={openQs.length || undefined} alert={blockingQs > 0} />
            <TabBtn
              id="clauses"
              cur={tab}
              set={setTab}
              label={cov.below ? 'Unread clauses' : 'All clauses'}
              count={cov.below ? cov.notCovered : cov.total}
              alert={cov.below}
            />
            <TabBtn id="activity" cur={tab} set={setTab} label="Activity" />
          </nav>
          {!verdictVisible && <div className="hidden shrink-0 py-2 animate-fade-in md:block">{primaryButton}</div>}
        </div>
      </div>

      <div className="animate-fade-in" key={tab}>
        {tab === 'findings' && (
          <div className="space-y-8">
            {c.findings.length === 0 && (
              <Card>
                <EmptyState icon={<Check size={20} />} title="No findings">
                  All {cov.total} clauses were examined and none raised an issue. A human still approves before signature.
                </EmptyState>
              </Card>
            )}
            {SEV_ORDER.map((s) => {
              const group = c.findings.filter((f) => f.severity === s)
              if (!group.length) return null
              if (s === 'low' && lowHidden)
                return (
                  <button key={s} onClick={() => setShowLowNow(true)} className="text-[13px] font-medium text-brand-600 hover:text-brand-700">
                    Show {group.length} low-severity finding{group.length > 1 ? 's' : ''} (hidden in Settings)
                  </button>
                )
              return (
                <section key={s}>
                  <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink-700">
                    <span className={`h-2 w-2 rounded-full ${sevDot(s)}`} />
                    {SEV_HEADING[s]}
                    <span className="font-normal text-ink-400">{group.length}</span>
                  </h3>
                  <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
                    {group.map((f) => (
                      <FindingRow
                        key={f.id}
                        f={f}
                        cid={c.id}
                        open={openFinding === f.id}
                        toggle={() => setOpenFinding((o) => (o === f.id ? null : f.id))}
                        myRole={closed ? null : myRole}
                        me={user}
                        canDecide={mayApprove && !closed}
                        settings={hax.settings}
                        saved={hax.saved[`${c.id}/${f.id}`]}
                        onDecide={(d) => onDecide(f.id, d)}
                        onMark={(m) => onMark(f.id, m)}
                        hax={hax}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        {tab === 'conflicts' && <Conflicts c={c} />}
        {tab === 'checks' && <Checks c={c} examined={cov.total - cov.notCovered} />}
        {tab === 'questions' && (
          <Questions c={c} user={user} mayApprove={mayApprove} closed={closed} onResolve={onResolve} />
        )}
        {tab === 'clauses' && (
          <Clauses
            c={c}
            onFinding={(section) => {
              const f = c.findings.find((x) => x.citation.section === section)
              if (f) setOpenFinding(f.id)
              goTab('findings')
            }}
          />
        )}
        {tab === 'activity' && <Activity c={c} audit={audit} />}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- */

/* ---------------- header facts: labelled, so "USA" or "19 Sep 2026" needs no guessing ---------------- */

function DealFacts({ c, closed }: { c: Contract; closed: boolean }) {
  const due = c.dealContext?.due && !closed ? c.dealContext.due : null
  return (
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
      <Fact label="AtliQ's role">{c.atliqRole === 'NDA party' ? 'NDA party' : c.atliqRole}</Fact>
      <Fact label="Their country">{c.country}</Fact>
      {c.value !== '-' && (
        <Fact label="Deal value">
          {c.value}
          {c.highValue && (
            <span className="ml-1.5 inline-flex" title="$100,000 or more: only Karandeep approves; routine delegations don't cover it">
              <Tag className="bg-slate-100 text-ink-600">High value</Tag>
            </span>
          )}
        </Fact>
      )}
      <Fact label="Length">
        {c.pages} page{c.pages === 1 ? '' : 's'}
      </Fact>
      {c.received !== '-' && (
        <Fact label="Received">
          {c.received.split(',')[0]}
        </Fact>
      )}
      {c.dealContext?.requestedBy && <Fact label="Requested by">{c.dealContext.requestedBy}</Fact>}
      {due && (
        <Fact label="Due">
          {due}
          <DueBadge days={daysFromToday(due)} />
        </Fact>
      )}
    </dl>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-400">{label}</dt>
      <dd className="flex items-center text-[13px] text-ink-700">{children}</dd>
    </div>
  )
}

/** Days left against the dataset's "today", coloured by urgency: overdue or ≤3 days red, ≤7 amber. */
function DueBadge({ days }: { days: number }) {
  if (Number.isNaN(days)) return null
  const text = days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`
  const tone = days <= 3 ? 'bg-risk-high-bg text-risk-high' : days <= 7 ? 'bg-risk-med-bg text-risk-med' : 'bg-slate-100 text-ink-600'
  return <Tag className={`ml-1.5 ${tone}`}>{text}</Tag>
}

const DOC_TYPES: Contract['docType'][] =['NDA', 'MSA', 'SOW', 'DPA', 'BAA', 'Partnership', 'Services', 'Subcontractor', 'Contractor', 'Pilot', 'Waiver']
const ROLES: Contract['atliqRole'][] = ['Supplier', 'Buyer', 'Partner', 'NDA party']
// AtliQ contracts through these two entities only (Dataset/atliq_entities.md).
const ENTITY_NAMES = ['AtliQ Technologies Pvt Ltd', 'AtliQ Inc']

/** G9 / G10 — what the AI detected, how sure it was, and a way to correct it. */
function DetectedDetails({ c, canEdit, hax }: { c: Contract; canEdit: boolean; hax: ReviewHax }) {
  const conf = c.detectConfidence ?? DETECT_CONF[c.id] ?? 0.9
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState({ docType: c.docType, atliqRole: c.atliqRole, entity: c.entity, country: c.country })
  const checked = c.detailsCheckedBy
  const unsure = conf < 0.85 && !checked
  if (editing)
    return (
      <form
        className="animate-fade-in mt-3 grid max-w-2xl gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          hax.onConfirmDetails(v)
          setEditing(false)
        }}
      >
        <label className="text-[13px] font-medium text-ink-800">
          Document type
          <select value={v.docType} onChange={(e) => setV({ ...v, docType: e.target.value as Contract['docType'] })} className={`${inputCls} mt-1`}>
            {DOC_TYPES.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="text-[13px] font-medium text-ink-800">
          AtliQ's role
          <select value={v.atliqRole} onChange={(e) => setV({ ...v, atliqRole: e.target.value as Contract['atliqRole'] })} className={`${inputCls} mt-1`}>
            {ROLES.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="text-[13px] font-medium text-ink-800">
          AtliQ entity named
          <select value={v.entity} onChange={(e) => setV({ ...v, entity: e.target.value })} className={`${inputCls} mt-1`}>
            {ENTITY_NAMES.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="text-[13px] font-medium text-ink-800">
          Counterparty country
          <input value={v.country} onChange={(e) => setV({ ...v, country: e.target.value })} className={`${inputCls} mt-1`} required pattern=".*\S.*" />
        </label>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" size="sm">
            Save corrections
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    )
  return (
    <div
      className={`mt-2 inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md px-2 py-0.5 text-[12px] ${
        unsure ? 'bg-risk-med-bg text-ink-800' : 'bg-white text-ink-600 ring-1 ring-slate-200/80'
      }`}
    >
      <Sparkles size={12} className={unsure ? 'text-risk-med' : 'text-ink-400'} />
      <span>{checked ? `${checked.corrected ? 'Corrected' : 'Confirmed'} by ${users[checked.by].name}:` : 'Detected by AI:'}</span>
      <span className="font-medium text-ink-900">
        {c.docType} · AtliQ as {c.atliqRole === 'NDA party' ? 'NDA party' : c.atliqRole.toLowerCase()}
      </span>
      {!checked && <span className={unsure ? 'font-medium text-risk-med' : 'text-ink-400'}>{Math.round(conf * 100)}% sure</span>}
      {canEdit && unsure && (
        <button onClick={() => hax.onConfirmDetails()} className="font-semibold text-brand-600 hover:text-brand-700">
          Looks right
        </button>
      )}
      {canEdit && (
        <button
          onClick={() => {
            setV({ docType: c.docType, atliqRole: c.atliqRole, entity: c.entity, country: c.country })
            setEditing(true)
          }}
          className="font-medium text-brand-600 hover:text-brand-700"
        >
          {unsure ? 'Change' : 'Correct'}
        </button>
      )}
    </div>
  )
}

function People({ c, user, approver, delegatedUntil }: { c: Contract; user: UserId; approver: UserId; delegatedUntil?: string }) {
  const rows: [string, UserId, string?][] = [
    ['Primary', c.primary],
    ...(c.secondary ? [['Secondary', c.secondary] as [string, UserId]] : []),
    ['Approver', approver, delegatedUntil ? `delegated until ${delegatedUntil}` : undefined],
  ]
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2">
      {rows.map(([label, u, note]) => (
        <div key={label} className="flex items-center gap-2">
          <Avatar u={u} size={30} />
          <div className="leading-tight">
            <dt className="text-[12px] text-ink-400">{label}</dt>
            <dd className="text-[13px] font-medium text-ink-900">
              {u === user ? 'You' : users[u].name}
              {note && <span className="ml-1 font-normal text-ink-400">· {note}</span>}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  )
}

function TabBtn({
  id,
  cur,
  set,
  label,
  count,
  alert,
}: {
  id: Tab
  cur: Tab
  set: (t: Tab) => void
  label: string
  count?: number
  alert?: boolean
}) {
  const active = cur === id
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => set(id)}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3.5 text-[14px] font-medium transition ${
        active ? 'border-ink-900 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-900'
      }`}
    >
      {label}
      {count !== undefined && (
        <span
          className={`rounded-full px-1.5 text-[12px] leading-5 tabular-nums ${
            alert ? 'bg-risk-high text-white' : active ? 'bg-ink-900 text-white' : 'bg-slate-200/80 text-ink-600'
          }`}
        >
          {count}
        </span>
      )}
      {count === undefined && alert && <span className="h-1.5 w-1.5 rounded-full bg-risk-high" />}
    </button>
  )
}

function MoreMenu({
  actions,
  onPick,
  onReject,
  extra = [],
}: {
  actions: [ContractStatus, string][]
  onPick: (s: ContractStatus, l: string) => void
  onReject: () => void
  extra?: { label: string; icon?: ReactNode; onClick: () => void }[]
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const pick = (fn: () => void) => {
    fn()
    if (ref.current) ref.current.open = false
  }
  return (
    <details ref={ref} className="relative [&[open]>summary]:bg-slate-100">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1 rounded-lg px-2.5 text-[14px] font-semibold text-ink-600 hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
        <MoreHorizontal size={18} /> <span className="sr-only sm:not-sr-only">More</span>
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-lg shadow-ink-900/10">
        {actions.map(([s, l]) => (
          <button key={s} onClick={() => pick(() => onPick(s, l))} className="block w-full rounded-md px-3 py-2 text-left text-[14px] text-ink-800 hover:bg-slate-50">
            {l}
          </button>
        ))}
        {extra.length > 0 && <div className="my-1 h-px bg-slate-100" />}
        {extra.map((x) => (
          <button key={x.label} onClick={() => pick(x.onClick)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[14px] text-ink-800 hover:bg-slate-50">
            <span className="text-ink-400">{x.icon}</span>
            {x.label}
          </button>
        ))}
        <div className="my-1 h-px bg-slate-100" />
        <button onClick={() => pick(onReject)} className="block w-full rounded-md px-3 py-2 text-left text-[14px] text-risk-high hover:bg-risk-high-bg">
          Reject contract
        </button>
      </div>
    </details>
  )
}

/* ----------------------------- finding ----------------------------- */

const DECISIONS: { d: HumanDecision; label: string; tip: string }[] = [
  { d: 'accepted', label: 'Accept', tip: 'Accept: you agree with the finding and the suggested next step. Updates the signing checklist.' },
  { d: 'modified', label: 'Modify', tip: 'Modify: there is an issue, but you will handle it differently. You can edit the suggested wording.' },
  { d: 'rejected', label: 'Reject', tip: 'Reject: the AI got this wrong. It stays in the audit trail.' },
  { d: 'escalated', label: 'Escalate', tip: 'Escalate: send to external counsel. Counsel receives the clause, not system access.' },
]
const DISMISS_REASONS = ['Already negotiated', 'Acceptable for this deal', 'Wrong clause', 'Not material']
const UNHELPFUL_REASONS = ['Not material', 'Wrong severity', 'Wrong quote', 'Missed context']

function Chip({ children, onClick, active }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${
        active ? 'border-ink-900 bg-ink-900 text-white' : 'border-slate-300 bg-white text-ink-700 hover:border-slate-400 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  )
}

function FindingRow({
  f,
  cid,
  open,
  toggle,
  myRole,
  me,
  canDecide,
  settings,
  saved,
  onDecide,
  onMark,
  hax,
}: {
  f: Finding
  cid: string
  open: boolean
  toggle: () => void
  myRole: 'primary' | 'secondary' | null
  me: UserId
  canDecide: boolean
  settings: Settings
  saved?: 'standard' | 'exception' | 'skip'
  onDecide: (d: HumanDecision) => void
  onMark: (m: ReviewerMark) => void
  hax: ReviewHax
}) {
  const [adding, setAdding] = useState(false)
  const [verdict, setVerdict] = useState<ReviewerMark['verdict']>('agree')
  const [regrade, setRegrade] = useState<Severity>('low')
  const [comment, setComment] = useState('')
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [unhelpful, setUnhelpful] = useState(false)
  const regraded = f.marks.find((m) => m.verdict === 'regrade')
  const drivers = f.drivers ?? DRIVERS[`${cid}/${f.id}`] ?? []
  const wording = f.editedFallback?.text ?? f.suggestedFallback?.text

  return (
    <article id={`finding-${f.id}`} className={`scroll-mt-40 ${open ? 'bg-white' : ''}`}>
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50/80"
      >
        <span className="w-12 shrink-0 font-mono text-[12px] text-ink-400">§{f.citation.section}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold leading-snug text-ink-900">{f.clauseTitle}</span>
          {!open && (
            <span className="mt-0.5 block truncate text-[13px] text-ink-500">
              AI suggests: {actionLabel[f.recommendedAction].toLowerCase()}
              {f.severityOverride && ` · re-graded to ${severityLabel[f.severityOverride.to].toLowerCase()} by ${users[f.severityOverride.by].name}`}
              {!f.severityOverride && regraded && ` · ${users[regraded.by].name} re-graded to ${regraded.regradeTo}`}
            </span>
          )}
        </span>
        <DecisionChip f={f} />
        <ChevronDown size={18} className={`shrink-0 text-ink-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="grid gap-6 px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:pl-[68px]">
            <div className="min-w-0 space-y-5">
              {f.abstained && (
                <Banner tone="warn" title="The AI abstained: your judgement is needed" icon={<AlertTriangle size={16} />}>
                  {f.abstentionReason}
                </Banner>
              )}
              <div>
                <p className="max-w-[68ch] text-[14px] leading-[1.65] text-ink-700">{f.whyItMatters}</p>
                {/* G11 — what drove the grade (clause facts only, G6) */}
                {drivers.length > 0 && (
                  <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-500">
                    <span className="mr-0.5">
                      {f.severity === 'unknown' ? 'Why it needs judgement:' : `Why ${severityLabel[f.severity].toLowerCase()}:`}
                    </span>
                    {drivers.map((d) => (
                      <span key={d} className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-ink-700">
                        {d}
                      </span>
                    ))}
                  </p>
                )}
                {f.severityOverride && (
                  <p className="mt-2 text-[12px] text-ink-500">
                    AI graded this <strong className="text-ink-700">{severityLabel[f.severity]}</strong>;{' '}
                    {users[f.severityOverride.by].name} changed it to{' '}
                    <strong className="text-ink-700">{severityLabel[f.severityOverride.to]}</strong>. Both are kept in the audit trail.
                  </p>
                )}
              </div>
              <Evidence quote={f.citation.quote} page={f.citation.page} section={f.citation.section} />

              {settings.showWording && f.suggestedFallback && (
                <div className="rounded-lg bg-brand-50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-semibold text-brand-700">Suggested wording</p>
                    <LabelPill l={f.suggestedFallback.label} />
                    {f.editedFallback && <Tag className="bg-white text-ink-700">Edited by {users[f.editedFallback.by].name}</Tag>}
                    <span className="ml-auto flex gap-1">
                      {canDecide && !editing && (
                        <button
                          onClick={() => {
                            setDraft(wording ?? '')
                            setEditing(true)
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-brand-700 hover:bg-brand-100"
                        >
                          <Pencil size={13} /> Edit
                        </button>
                      )}
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(wording ?? '')
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-brand-700 hover:bg-brand-100"
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
                      </button>
                    </span>
                  </div>
                  {editing ? (
                    <form
                      className="mt-2 space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        hax.onEditWording(f.id, draft.trim())
                        setEditing(false)
                      }}
                    >
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={4}
                        required
                        aria-label="Edit suggested wording"
                        className={`${inputCls} h-auto py-2 leading-relaxed`}
                      />
                      <div className="flex gap-2">
                        <Button type="submit" variant="primary" size="sm">
                          Save wording
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <p className="mt-2 text-[14px] leading-[1.65] text-ink-900">{wording}</p>
                  )}
                  {f.editedFallback && !editing && (
                    <details className="mt-2 text-[13px] text-ink-500">
                      <summary className="cursor-pointer font-medium hover:text-ink-800">AI's original wording</summary>
                      <p className="mt-1 leading-relaxed">{f.suggestedFallback.text}</p>
                    </details>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-brand-100 pt-3">
                    <p className="text-[12px] text-ink-500">Draft for human review · based on {f.suggestedFallback.basis}</p>
                    {/* G15 — feedback on the draft itself */}
                    {f.wordingFeedback ? (
                      <p className="text-[12px] text-ink-500">
                        Thanks, rated “{{ usable: 'usable as is', edited: 'usable with edits', unusable: 'not usable' }[f.wordingFeedback]}”
                      </p>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-500">
                        Usable?
                        <Chip onClick={() => hax.onWordingFeedback(f.id, 'usable')}>As is</Chip>
                        <Chip onClick={() => hax.onWordingFeedback(f.id, 'edited')}>With edits</Chip>
                        <Chip onClick={() => hax.onWordingFeedback(f.id, 'unusable')}>No</Chip>
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-3 border-t border-slate-100 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="text-[13px] text-ink-500">
                      AI suggests <strong className="font-semibold text-ink-900">{actionLabel[f.recommendedAction].toLowerCase()}</strong>
                    </span>
                    {settings.showConfidence && <Confidence value={f.confidence} />}
                  </div>
                  {canDecide && (
                    <div className="flex flex-wrap items-center gap-2">
                      {f.decision === 'pending' && (
                        <Button variant="ghost" size="sm" onClick={() => setDismissing((v) => !v)} title="Dismiss: the clause is fine for this deal">
                          Not an issue
                        </Button>
                      )}
                      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 shadow-[0_1px_1px_rgba(15,39,68,0.04)]">
                        {DECISIONS.map(({ d, label, tip }) => (
                          <button
                            key={d}
                            title={tip}
                            onClick={() => onDecide(f.decision === d ? 'pending' : d)}
                            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition ${
                              f.decision === d ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-slate-100'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* G8 — dismiss in one click, reason optional */}
                {dismissing && f.decision === 'pending' && (
                  <div className="animate-fade-in flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 px-3 py-2.5 text-[13px] text-ink-600">
                    <span className="mr-1">Why isn't it an issue?</span>
                    {DISMISS_REASONS.map((r) => (
                      <Chip
                        key={r}
                        onClick={() => {
                          hax.onDismiss(f.id, r)
                          setDismissing(false)
                        }}
                      >
                        {r}
                      </Chip>
                    ))}
                    <button
                      onClick={() => {
                        hax.onDismiss(f.id)
                        setDismissing(false)
                      }}
                      className="ml-1 text-[12px] font-medium text-ink-500 underline-offset-2 hover:text-ink-900 hover:underline"
                    >
                      Skip reason
                    </button>
                  </div>
                )}

                {/* G9 — approver corrects the grade */}
                {canDecide && (
                  <label className="flex items-center gap-2 text-[13px] text-ink-500">
                    Severity
                    <select
                      value={f.severityOverride?.to ?? f.severity}
                      onChange={(e) => hax.onRegrade(f.id, e.target.value as Severity)}
                      className="h-8 rounded-md border border-slate-300 bg-white px-2 text-[13px] text-ink-800"
                    >
                      {(['high', 'medium', 'low', 'unknown'] as Severity[]).map((s) => (
                        <option key={s} value={s}>
                          {severityLabel[s]}
                          {s === f.severity ? ' (AI)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {/* G13 / G14 — learn only what a person chooses to keep */}
                {canDecide &&
                  f.suggestedFallback &&
                  (f.decision === 'accepted' || f.decision === 'modified') &&
                  (saved ? (
                    saved !== 'skip' && (
                      <p className="flex items-center gap-1.5 text-[13px] text-ink-600">
                        <Check size={14} className="shrink-0 text-risk-low" />
                        Saved as {saved === 'standard' ? 'a standard position' : 'a one-off exception'}. Waiting for Karandeep's approval
                        before the assistant uses it.
                      </p>
                    )
                  ) : (
                    <div className="animate-fade-in rounded-lg border border-slate-200 bg-white px-3.5 py-3">
                      <p className="text-[13px] font-medium text-ink-900">Remember this outcome for future reviews?</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Chip onClick={() => hax.onSavePrecedent(f.id, 'standard')}>Standard position</Chip>
                        <Chip onClick={() => hax.onSavePrecedent(f.id, 'exception')}>One-off exception</Chip>
                        <button onClick={() => hax.onSavePrecedent(f.id, 'skip')} className="ml-1 text-[12px] font-medium text-ink-500 hover:text-ink-900">
                          Don't save
                        </button>
                      </div>
                      <p className="mt-2 text-[12px] text-ink-400">Nothing is learned until Karandeep approves it. Exceptions never become the standard.</p>
                    </div>
                  ))}
              </div>
            </div>

            <aside className="space-y-5 lg:border-l lg:border-slate-100 lg:pl-6">
              <div>
                <p className="text-[13px] font-semibold text-ink-900">AtliQ precedent</p>
                {f.precedents.length ? (
                  <ul className="mt-2 space-y-3">
                    {f.precedents.map((p, i) => (
                      <li key={i}>
                        <p className="text-[13px] leading-snug text-ink-800">{p.outcome}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-400">
                          {p.contract} · {p.date} <LabelPill l={p.label} />
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
                    No AtliQ precedent for this clause. Judge it on deal context; absence of precedent isn't approval.
                  </p>
                )}
                {f.precedents.length > 0 && <p className="mt-3 text-[12px] text-ink-400">Precedent is context, not policy.</p>}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-semibold text-ink-900">Reviewers</p>
                  {myRole && !adding && (
                    <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700">
                      <MessageSquarePlus size={14} /> Add yours
                    </button>
                  )}
                </div>
                {f.marks.length === 0 && !adding && <p className="mt-1 text-[13px] text-ink-400">No reviewer assessments yet.</p>}
                <ul className="mt-2 space-y-3">
                  {f.marks.map((m, i) => (
                    <li key={i} className="flex gap-2.5">
                      <Avatar u={m.by} size={24} />
                      <div className="min-w-0 text-[13px]">
                        <p className="leading-snug text-ink-900">
                          <span className="font-semibold">{users[m.by].name}</span>{' '}
                          {m.verdict === 'agree' && <span className="text-ink-500">agrees</span>}
                          {m.verdict === 'regrade' && <span className="text-risk-med">re-graded to {m.regradeTo}</span>}
                          {m.verdict === 'comment' && <span className="text-ink-500">commented</span>}
                        </p>
                        {m.comment && <p className="mt-0.5 leading-relaxed text-ink-700">{m.comment}</p>}
                        <p className="mt-0.5 text-[12px] text-ink-400">
                          {m.as} reviewer · {m.at}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {adding && myRole && (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      onMark({
                        by: me,
                        as: myRole,
                        verdict,
                        regradeTo: verdict === 'regrade' ? regrade : undefined,
                        comment: comment.trim(),
                        at: new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
                      })
                      setComment('')
                      setAdding(false)
                    }}
                  >
                    <Segmented
                      value={verdict}
                      onChange={setVerdict}
                      options={[
                        { value: 'agree', label: 'Agree' },
                        { value: 'regrade', label: 'Re-grade' },
                        { value: 'comment', label: 'Comment' },
                      ]}
                    />
                    {verdict === 'regrade' && (
                      <select value={regrade} onChange={(e) => setRegrade(e.target.value as Severity)} className={inputCls}>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                    )}
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder={verdict === 'agree' ? 'Optional note' : 'Why?'}
                      required={verdict !== 'agree'}
                      rows={2}
                      className={`${inputCls} h-auto py-2`}
                    />
                    <div className="flex gap-2">
                      <Button type="submit" variant="primary" size="sm">
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </aside>
          </div>

          {/* G15 — granular feedback on the finding */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-3 text-[13px] text-ink-500 lg:pl-[68px]">
            {f.feedback ? (
              <>
                <span>
                  Thanks, {users[f.feedback.by].name} rated this{' '}
                  {f.feedback.useful ? 'helpful' : `not helpful (${(f.feedback.reason ?? 'no reason').toLowerCase()})`}. Feedback tunes the
                  assistant.
                </span>
                <button onClick={() => hax.onFeedback(f.id, undefined)} className="font-medium text-ink-500 hover:text-ink-900">
                  Change
                </button>
              </>
            ) : unhelpful ? (
              <>
                <span className="mr-1">What was wrong?</span>
                {UNHELPFUL_REASONS.map((r) => (
                  <Chip
                    key={r}
                    onClick={() => {
                      hax.onFeedback(f.id, { useful: false, reason: r, by: me })
                      setUnhelpful(false)
                    }}
                  >
                    {r}
                  </Chip>
                ))}
                <button onClick={() => setUnhelpful(false)} className="ml-1 text-[12px] font-medium hover:text-ink-900">
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span>Was this finding helpful?</span>
                <button
                  onClick={() => hax.onFeedback(f.id, { useful: true, by: me })}
                  aria-label="Helpful"
                  className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-white hover:text-risk-low"
                >
                  <ThumbsUp size={16} />
                </button>
                <button
                  onClick={() => setUnhelpful(true)}
                  aria-label="Not helpful"
                  className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-white hover:text-risk-high"
                >
                  <ThumbsDown size={16} />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </article>
  )
}

function DecisionChip({ f }: { f: Finding }) {
  if (f.decision === 'pending')
    return <span className="hidden shrink-0 text-[13px] text-ink-400 sm:block">Undecided</span>
  const tone = f.decision === 'escalated' ? 'text-risk-med' : f.decision === 'rejected' ? 'text-ink-600' : 'text-risk-low'
  if (f.decision === 'rejected' && f.dismissReason !== undefined)
    return (
      <span className="hidden shrink-0 items-center gap-1 text-[13px] font-medium text-ink-600 sm:inline-flex" title={f.dismissReason || undefined}>
        <Check size={14} strokeWidth={2.5} /> Not an issue
        {f.decidedBy && <span className="font-normal text-ink-400">· {users[f.decidedBy].name}</span>}
      </span>
    )
  return (
    <span className={`hidden shrink-0 items-center gap-1 text-[13px] font-medium sm:inline-flex ${tone}`}>
      <Check size={14} strokeWidth={2.5} />
      {f.decision[0].toUpperCase() + f.decision.slice(1)}
      {f.decidedBy && <span className="font-normal text-ink-400">by {users[f.decidedBy].name}</span>}
    </span>
  )
}

/* ----------------------------- conflicts ----------------------------- */

function Conflicts({ c }: { c: Contract }) {
  const blocking = c.conflicts.filter((x) => x.prior.status === 'active')
  const other = c.conflicts.filter((x) => x.prior.status !== 'active')
  if (!c.conflicts.length)
    return (
      <Card>
        <EmptyState icon={<Check size={20} />} title="No conflicts with existing obligations">
          Checked against the obligation register (live, expired and superseded). Promises made off-document are not covered.
        </EmptyState>
      </Card>
    )
  const item = (x: Contract['conflicts'][number]) => (
    <Card key={x.id}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityPill s={x.severity} />
        <ObligationPill s={x.prior.status} />
        <span className="text-[13px] text-ink-500">{x.prior.reliesOn}</span>
      </div>
      <p className="mt-3 max-w-[72ch] text-[14px] leading-[1.65] text-ink-800">{x.explanation}</p>
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-400">This contract</p>
          <Evidence quote={x.newClause.quote} page={x.newClause.page} section={x.newClause.section} tone={x.prior.status === 'active' ? 'danger' : 'muted'} />
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-400">Already promised</p>
          <Evidence
            quote={x.prior.quote}
            label={`${x.prior.contract}${x.prior.clause ? ` cl. ${x.prior.clause}` : ''} · ${x.prior.obligationId} · ${x.prior.effective} → ${x.prior.expires}`}
            tone={x.prior.status === 'active' ? 'danger' : 'muted'}
          />
          {x.prior.sourceFile && <p className="mt-1.5 font-mono text-[11px] text-ink-300">{x.prior.sourceFile}</p>}
        </div>
      </div>
    </Card>
  )
  return (
    <div className="space-y-8">
      {blocking.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold text-ink-700">Blocking · cannot be auto-cleared</h3>
          {blocking.map(item)}
        </section>
      )}
      {other.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold text-ink-700">Not blocking · expired or superseded, shown for context</h3>
          {other.map(item)}
        </section>
      )}
    </div>
  )
}

/* ----------------------------- checks ----------------------------- */

function DealContextCard({ d, file }: { d: DealContext; file?: string }) {
  return (
    <Card title="Deal context" subtitle={`From contract_tracker.csv · ${d.trackerId}`} right={<Tag className="bg-slate-100 text-ink-600">Context only</Tag>}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Field label="Requested by" value={d.requestedBy || '-'} />
        <Field label="Tracker status" value={d.trackerStatus || '-'} />
        {d.received && <Field label="Received" value={d.received} />}
        {d.due && <Field label="Wanted by" value={d.due} />}
        {d.signed && <Field label="Signed" value={d.signed} />}
        {d.expires && <Field label="Expires" value={d.expires} />}
      </dl>
      {d.notes && <p className="mt-4 text-[14px] leading-relaxed text-ink-800">{d.notes}</p>}
      {d.provenance && <p className="mt-2 text-[13px] italic leading-relaxed text-ink-500">{d.provenance}</p>}
      {file && <p className="mt-3 font-mono text-[11px] text-ink-400">{file}</p>}
      <p className="mt-3 flex gap-2 rounded-md bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-ink-500">
        <Info size={14} className="mt-px shrink-0" />
        Deadlines and who is asking never change how clauses are graded.
      </p>
    </Card>
  )
}

function Checks({ c, examined }: { c: Contract; examined: number }) {
  const e = c.entityCheck
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card
        title="Legal entity"
        subtitle={`Rule ${e.rule}`}
        right={e.status === 'pass' ? <Tag className="bg-risk-low-bg text-risk-low"><Check size={13} /> Pass</Tag> : <Tag className="bg-risk-high-bg text-risk-high"><X size={13} /> Fail</Tag>}
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
          <Field label="Named in contract" value={e.namedEntity} bad={e.status === 'fail'} />
          <Field label="Required" value={e.expectedEntity} />
          <Field label="Client location" value={e.clientLocation} />
          <Field label="Governing law" value={e.governingLaw} />
          <Field label="Invoicing" value={e.invoicingConsistent ? 'Consistent' : 'Inconsistent'} bad={!e.invoicingConsistent} />
          <Field label="Signatory" value={e.signatoryValid ? 'Valid' : 'Invalid'} bad={!e.signatoryValid} />
        </dl>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-600">{e.note}</p>
      </Card>

      {c.dealContext && <DealContextCard d={c.dealContext} file={c.sourceFile} />}

      <Card title="Counterparty history" subtitle={`AtliQ's own records · ${c.legitimacy.source}`}>
        {!c.legitimacy.held && (
          <Tag className="mb-2 bg-slate-100 text-ink-600">
            <Inbox size={13} /> No history held
          </Tag>
        )}
        <p className="text-[14px] leading-relaxed text-ink-800">{c.legitimacy.summary}</p>
        <p className="mt-3 flex gap-2 rounded-md bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-ink-500">
          <Info size={14} className="mt-px shrink-0" />
          Shown for context only. Payment history, country and company size never change how clauses are graded.
        </p>
        {c.legitimacy.events.length > 0 && (
          <ol className="mt-4 space-y-3">
            {c.legitimacy.events.map((ev, i) => (
              <li key={i} className="flex gap-3 text-[13px]">
                <span className="w-16 shrink-0 tabular-nums text-ink-400">{ev.date}</span>
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ev.kind === 'On time' ? 'bg-risk-low' : ev.kind === 'Missed cycle' ? 'bg-risk-med' : 'bg-risk-high'}`}
                />
                <span className="min-w-0">
                  <span className="font-medium text-ink-900">{ev.kind}</span>
                  <span className="block text-ink-600">{ev.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title="Brand and reputation" subtitle="Publicity, non-disparagement, conduct">
        {c.brand.length === 0 ? (
          <p className="text-[14px] text-ink-600">No exposure found across {examined} examined clauses.</p>
        ) : (
          <ul className="space-y-5">
            {c.brand.map((b, i) => (
              <li key={i} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityPill s={b.severity} />
                  <span className="text-[14px] font-semibold text-ink-900">{b.type}</span>
                </div>
                <Evidence quote={b.citation.quote} page={b.citation.page} section={b.citation.section} />
                <p className="text-[13px] text-ink-500">{b.note}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Contract family" subtitle={c.family?.relation ?? 'Standalone agreement'}>
        {c.family ? (
          <>
            {c.family.parent && (
              <p className="flex items-center gap-2 text-[14px]">
                <GitBranch size={16} className="text-ink-400" />
                <span className="font-semibold text-ink-900">{c.family.parent.name}</span>
                <span className="text-ink-400">signed {c.family.parent.signed}</span>
              </p>
            )}
            <p className={`text-[13px] leading-relaxed ${c.family.orphan ? 'text-risk-med' : 'mt-2 text-ink-600'}`}>{c.family.note}</p>
          </>
        ) : (
          <p className="text-[14px] text-ink-600">No parent or child agreements linked.</p>
        )}
      </Card>
    </div>
  )
}

/* ----------------------------- questions ----------------------------- */

function Questions({
  c,
  user,
  mayApprove,
  closed,
  onResolve,
}: {
  c: Contract
  user: UserId
  mayApprove: boolean
  closed: boolean
  onResolve: (id: string) => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  if (!c.missingInfo.length)
    return (
      <Card>
        <EmptyState icon={<Check size={20} />} title="Nothing outstanding">
          No questions are waiting on Finance, the CTO or a reviewer.
        </EmptyState>
      </Card>
    )
  const sorted = [...c.missingInfo].sort((a, b) => Number(a.resolved) - Number(b.resolved) || Number(b.blocking) - Number(a.blocking))
  return (
    <Card flush>
      <ul className="divide-y divide-slate-100">
        {sorted.map((m) => (
          <li key={m.id} className="flex flex-wrap items-start gap-4 px-5 py-4 sm:px-6">
            {m.assignee ? (
              <Avatar u={m.assignee} size={32} />
            ) : (
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-ink-500">
                <Users size={15} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink-500">
                <span className="font-medium text-ink-800">{m.assignee ? users[m.assignee].name : m.owner}</span>
                {m.assignee && ` · ${m.owner.toLowerCase()}`}
                {m.blocking && !m.resolved && <span className="ml-2 font-medium text-risk-high">Blocks signing</span>}
              </p>
              <p className={`mt-1 text-[14px] leading-relaxed ${m.resolved ? 'text-ink-400 line-through' : 'text-ink-900'}`}>{m.question}</p>
            </div>
            {m.resolved ? (
              <Tag className="bg-risk-low-bg text-risk-low">
                <Check size={13} /> Answered
              </Tag>
            ) : (
              !closed && (
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const to = m.assignee ? users[m.assignee].name : `${m.owner} team`
                      navigator.clipboard?.writeText(`Hi ${to}, on the ${c.counterparty} ${c.docType} (${c.id}): ${m.question} Thanks.`)
                      setCopied(m.id)
                      setTimeout(() => setCopied(null), 1500)
                    }}
                  >
                    {copied === m.id ? <Check size={14} /> : <Copy size={14} />} {copied === m.id ? 'Copied' : 'Copy message'}
                  </Button>
                  {(mayApprove || m.assignee === user) && (
                    <Button size="sm" onClick={() => onResolve(m.id)}>
                      Mark answered
                    </Button>
                  )}
                </span>
              )
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/* ----------------------------- clauses ----------------------------- */

function Clauses({ c, onFinding }: { c: Contract; onFinding: (section: string) => void }) {
  const [f, setF] = useState<'all' | 'finding' | 'no-issue' | 'not-covered'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const cov = coverage(c)
  const rows = c.clauses.filter((r) => f === 'all' || r.outcome === f)
  return (
    <div className="space-y-4">
      {cov.below && (
        <Banner tone="warn" title="Below the coverage threshold: no overall verdict" icon={<AlertTriangle size={16} />}>
          {cov.notCovered} of {cov.total} clauses could not be read (parse quality {Math.round(c.parseQuality * 100)}%). Missing
          findings in those clauses do not mean missing risk.
        </Banner>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={f}
          onChange={setF}
          options={[
            { value: 'all', label: 'All', count: cov.total },
            { value: 'finding', label: 'Flagged', count: cov.flagged },
            { value: 'no-issue', label: 'No issue', count: cov.noIssue },
            { value: 'not-covered', label: 'Not examined', count: cov.notCovered },
          ]}
        />
        <p className="text-[13px] text-ink-500">Threshold {Math.round(c.coverageThreshold * 100)}%</p>
      </div>
      <Card flush>
        {rows.length === 0 ? (
          <EmptyState icon={<Check size={20} />} title={f === 'not-covered' ? 'Every clause was examined' : 'No clauses in this group'} />
        ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.section} className="border-b border-slate-100 last:border-b-0">
                <button
                  disabled={!r.text}
                  aria-expanded={open === r.section}
                  onClick={() => setOpen((o) => (o === r.section ? null : r.section))}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left enabled:hover:bg-slate-50 sm:px-6"
                >
                  <span className="w-14 shrink-0 font-mono text-[12px] text-ink-400">{r.section}</span>
                  <span className={`min-w-0 flex-1 truncate text-[14px] ${r.outcome === 'not-covered' ? 'text-ink-400' : 'text-ink-900'}`}>{r.title}</span>
                  {r.outcome === 'finding' && <span className="text-[13px] font-medium text-risk-high">Flagged</span>}
                  {r.outcome === 'no-issue' && <span className="text-[13px] text-ink-400">No issue</span>}
                  {r.outcome === 'not-covered' && <span className="text-[13px] font-medium text-risk-med">Unreadable</span>}
                </button>
                {open === r.section && r.text && (
                  <div className="px-5 pb-4 sm:px-6 sm:pl-[5.75rem]">
                    <p className="max-w-[80ch] whitespace-pre-line text-[13px] leading-[1.7] text-ink-700">{r.text}</p>
                    {r.outcome === 'finding' && (
                      <button onClick={() => onFinding(r.section)} className="mt-2 text-[13px] font-medium text-brand-600 hover:text-brand-700">
                        Open the finding →
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* ----------------------------- activity ----------------------------- */

function Activity({ c, audit }: { c: Contract; audit: AuditEntry[] }) {
  const mine = audit.filter((a) => a.detail.includes(c.id))
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card title="History" subtitle="Every AI output, retrieval and human decision on this contract">
        {mine.length === 0 ? (
          <p className="text-[14px] text-ink-500">No activity recorded yet.</p>
        ) : (
          <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[3px] before:top-2 before:w-px before:bg-slate-200">
            {mine.map((e) => (
              <li key={e.id} className="relative flex gap-4">
                <span className={`relative mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full ring-4 ring-white ${e.kind === 'human' ? 'bg-brand-600' : 'bg-ink-300'}`} />
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-ink-900">{e.action}</p>
                  <p className="text-[13px] leading-relaxed text-ink-600">{e.detail}</p>
                  <p className="mt-0.5 text-[12px] text-ink-400">
                    {e.actor} · {e.at}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title="Review record">
        <dl className="space-y-4">
          <Field label="Model" value={c.audit.model} />
          <Field label="Prompt · rules" value={`${c.audit.promptVersion} · ${c.audit.rulesVersion}`} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Sources retrieved" value={c.audit.sourcesUsed} />
            <Field label="Parse quality" value={`${Math.round(c.parseQuality * 100)}%`} bad={c.parseQuality < 0.85} />
            <Field label="Completed" value={c.audit.completedAt} />
            <Field label="Duration" value={`${c.audit.durationSeconds}s`} />
          </div>
          <Confidence value={c.audit.overallConfidence} />
        </dl>
      </Card>
    </div>
  )
}

