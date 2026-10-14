import { useEffect, useRef, useState } from 'react'
import { Lock, UploadCloud, Check, Loader2, FileText, Search, Inbox, ArrowDownLeft, ArrowUpRight, X, ChevronRight, Sparkles, Clock } from 'lucide-react'
import {
  approverOf,
  blockReasons,
  coverage,
  users,
  userIds,
  type AuditEntry,
  type AuditKind,
  type Contract,
  delegationActive,
  type Delegation,
  type Obligation,
  type ObligationStatus,
  type Precedent,
  type UserId,
} from './data'
import {
  Avatar,
  Banner,
  Button,
  Card,
  EmptyState,
  LabelPill,
  LabelledInput,
  ObligationPill,
  PageHeader,
  Segmented,
  StatePill,
  Tag,
  inputCls,
} from './ui'
import { Capabilities } from './overlays'
import type { PendingPrecedent } from './hax'
import { api, waitForJob } from './api'

/* ------------------------------- Queue ------------------------------- */

export type QueueFilter = 'all' | 'mine' | 'open' | 'closed'

export function Queue({
  data,
  hidden,
  user,
  delegations,
  query,
  clearQuery,
  onOpen,
  filter,
  setFilter,
}: {
  filter: QueueFilter
  setFilter: (f: QueueFilter) => void
  data: Contract[]
  hidden: number
  user: UserId
  delegations: Delegation[]
  query: string
  clearQuery: () => void
  onOpen: (id: string) => void
}) {
  const isMine = (c: Contract) => c.primary === user || c.secondary === user || approverOf(c, delegations).user === user
  const isClosed = (c: Contract) => c.status === 'Signed' || c.status === 'Rejected'
  const rows = data.filter((c) =>
    filter === 'all' ? true : filter === 'mine' ? isMine(c) && !isClosed(c) : filter === 'open' ? !isClosed(c) : isClosed(c),
  )
  const empty = {
    mine: ['Nothing needs you right now', 'Contracts where you are a reviewer or the approver will appear here.'],
    open: ['No open contracts', 'New contracts appear here as soon as they are analysed.'],
    closed: ['Nothing signed or rejected yet', 'Closed reviews stay here, read-only, for the audit record.'],
    all: ['No contracts yet', 'Upload a contract to start the first review.'],
  }[filter]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contract reviews"
        subtitle="Client and partner contracts, plus AtliQ's own drafts."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'Open', count: data.filter((c) => !isClosed(c)).length },
            { value: 'mine', label: 'Needs me', count: data.filter((c) => isMine(c) && !isClosed(c)).length },
            { value: 'closed', label: 'Closed', count: data.filter(isClosed).length },
            { value: 'all', label: 'All', count: data.length },
          ]}
        />
        {hidden > 0 && (
          <p className="flex items-center gap-1.5 text-[13px] text-ink-500">
            <Lock size={13} /> {hidden} restricted to other reviewers
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
        {rows.length > 0 && (
          <div className="hidden grid-cols-[minmax(0,1.6fr)_150px_minmax(0,1.3fr)_90px_24px] gap-4 border-b border-slate-100 bg-slate-50/60 px-5 py-2.5 text-[12px] font-medium text-ink-500 lg:grid">
            <span>Contract</span>
            <span>AI assessment</span>
            <span>What's blocking</span>
            <span>Reviewers</span>
            <span />
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {rows.map((c) => {
            const cov = coverage(c)
            const reasons = isClosed(c) ? [] : blockReasons(c)
            return (
              <li key={c.id}>
                <button
                  onClick={() => onOpen(c.id)}
                  className="group grid w-full grid-cols-1 gap-x-4 gap-y-2 px-5 py-4 text-left transition hover:bg-slate-50/80 lg:grid-cols-[minmax(0,1.6fr)_150px_minmax(0,1.3fr)_90px_24px] lg:items-center"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      {c.direction === 'outbound' ? (
                        <ArrowUpRight size={15} className="shrink-0 text-brand-600" aria-label="Outbound draft" />
                      ) : (
                        <ArrowDownLeft size={15} className="shrink-0 text-ink-300" aria-label="Received" />
                      )}
                      <span className="truncate text-[15px] font-semibold text-ink-900">{c.counterparty}</span>
                    </span>
                    <span className="mt-0.5 block truncate pl-[23px] text-[13px] text-ink-500">
                      {c.docType}
                      {c.presentedAs && ` · labelled “${c.presentedAs}”`} · {c.value !== '-' ? `${c.value} · ` : ''}
                      {c.received.split(',')[0]}
                      {c.dealContext?.due && !isClosed(c) && <span className="font-medium text-risk-med"> · due {c.dealContext.due.replace(' 2026', '')}</span>}
                    </span>
                  </span>
                  <span className="pl-[23px] lg:pl-0">
                    {isClosed(c) ? (
                      <Tag className="bg-slate-100 text-ink-600">{c.status}</Tag>
                    ) : (
                      <StatePill s={cov.below ? 'insufficient-evidence' : c.state} />
                    )}
                  </span>
                  <span className="min-w-0 pl-[23px] text-[13px] lg:pl-0">
                    {reasons.length ? (
                      <>
                        <span className="block truncate font-medium text-ink-800">{reasons[0]}</span>
                        {reasons.length > 1 && <span className="text-ink-400">+{reasons.length - 1} more</span>}
                      </>
                    ) : (
                      <span className="text-ink-400">{isClosed(c) ? '-' : 'Nothing: ready for a decision'}</span>
                    )}
                  </span>
                  <span className="hidden -space-x-1 lg:flex">
                    <Avatar u={c.primary} size={26} ring />
                    {c.secondary && <Avatar u={c.secondary} size={26} ring />}
                  </span>
                  <ChevronRight size={18} className="hidden text-ink-300 transition group-hover:translate-x-0.5 group-hover:text-ink-700 lg:block" />
                </button>
              </li>
            )
          })}
        </ul>
        {rows.length === 0 &&
          (query ? (
            <EmptyState
              icon={<Search size={20} />}
              title={`No contracts match “${query}”`}
              action={
                <Button onClick={clearQuery}>
                  <X size={14} /> Clear search
                </Button>
              }
            >
              Search covers counterparty, document name and ID{hidden ? ', within the contracts you can access' : ''}.
            </EmptyState>
          ) : (
            <EmptyState icon={<Inbox size={20} />} title={empty[0]}>
              {empty[1]}
            </EmptyState>
          ))}
      </div>
    </div>
  )
}

/* ------------------------------ Register ----------------------------- */

export function Register({ obligations }: { obligations: Obligation[] }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | ObligationStatus>('active')
  const rows = obligations.filter(
    (o) =>
      (status === 'all' || o.status === status) &&
      [o.id, o.clauseType, o.counterparty, o.sourceContract, o.summary, o.entity].join(' ').toLowerCase().includes(q.toLowerCase()),
  )
  const count = (s: ObligationStatus) => obligations.filter((o) => o.status === s).length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Obligation register"
        subtitle="What AtliQ has already promised, with dates. Every new contract is checked against the live entries. Only human-approved obligations are added."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Live', count: count('active') },
            { value: 'expired', label: 'Expired', count: count('expired') },
            { value: 'superseded', label: 'Superseded', count: count('superseded') },
            { value: 'all', label: 'All', count: obligations.length },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Counterparty, clause type, entity" />
      </div>
      <Card flush className="overflow-hidden">
        <div className="-mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[14px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/60 text-[12px] text-ink-500">
                <th className="px-6 py-2.5 font-medium">Obligation</th>
                <th className="px-3 py-2.5 font-medium">Counterparty</th>
                <th className="px-3 py-2.5 font-medium">In force</th>
                <th className="px-6 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((o) => (
                <tr key={o.id} className="align-top">
                  <td className="px-6 py-4">
                    <p className={`font-semibold ${o.status === 'active' ? 'text-ink-900' : 'text-ink-500'}`}>
                      {o.clauseType}
                      {o.basis === 'exception' && <span className="ml-2 align-middle"><LabelPill l="exception" /></span>}
                    </p>
                    <p className={`mt-1 max-w-md text-[13px] leading-relaxed ${o.status === 'active' ? 'text-ink-600' : 'text-ink-400'}`}>{o.summary}</p>
                    {o.supersededBy && <p className="mt-1 text-[13px] text-ink-500">Replaced by {o.supersededBy}</p>}
                    {o.quote && <p className="mt-1.5 max-w-md border-l-2 border-slate-200 pl-2.5 text-[12px] italic leading-relaxed text-ink-500">“{o.quote}”</p>}
                  </td>
                  <td className="px-3 py-4">
                    <p className="font-medium text-ink-800">{o.counterparty}</p>
                    <p className="text-[13px] text-ink-400">{o.sourceContract}{o.clause ? ` · cl. ${o.clause}` : ''}</p>
                    {o.sourceFile && <p className="font-mono text-[11px] text-ink-300">{o.sourceFile}</p>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-4 text-[13px] tabular-nums text-ink-600">
                    {o.effective}
                    <span className="block text-ink-400">to {o.expires}</span>
                  </td>
                  <td className="px-6 py-4">
                    <ObligationPill s={o.status} />
                    <p className="mt-1 font-mono text-[12px] text-ink-300">{o.id}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState icon={<Search size={20} />} title="No matching obligations" action={q ? <Button onClick={() => setQ('')}>Clear search</Button> : undefined}>
              {q ? `Nothing in this view matches “${q}”. Try “All” to include expired and superseded entries.` : 'No obligations with this status.'}
            </EmptyState>
          )}
        </div>
      </Card>
    </div>
  )
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block w-full sm:w-72">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputCls} pl-9`} />
    </label>
  )
}

/* ------------------------------ Precedent ----------------------------- */

export function PrecedentSearch({
  precedents,
  pending,
  canApprove,
  onApprove,
  onDiscard,
}: {
  precedents: Precedent[]
  pending: PendingPrecedent[]
  canApprove: boolean
  onApprove: (id: string) => void
  onDiscard: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const waiting = pending.filter((p) => p.status === 'pending')
  const all = precedents
  const [label, setLabel] = useState<'all' | 'standard' | 'exception' | 'unknown'>('all')
  const types = Array.from(new Set(all.map((p) => p.clauseType)))
  const [type, setType] = useState('all')
  const rows = all.filter(
    (p) =>
      (label === 'all' || p.label === label) &&
      (type === 'all' || p.clauseType === type) &&
      [p.counterparty, p.contract, p.asked, p.outcome, p.context].join(' ').toLowerCase().includes(q.toLowerCase()),
  )
  return (
    <div className="space-y-6">
      <PageHeader
        title="Precedent"
        subtitle="How AtliQ handled similar asks before. Context for a judgement call; AtliQ has no fixed policy on commercial terms."
      />
      {waiting.length > 0 && (
        <section className="rounded-xl border border-risk-med/25 bg-risk-med-bg/60 p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink-900">
            <Clock size={16} className="text-risk-med" /> Pending from your decisions
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-600">
            The assistant only learns from outcomes Karandeep approves. Until then these are not used in reviews.
          </p>
          <ul className="mt-4 space-y-3">
            {waiting.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-4 rounded-lg bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-500">
                    {p.clauseType} <LabelPill l={p.label} />
                  </p>
                  <p className="mt-1 text-[14px] font-medium leading-snug text-ink-900">{p.outcome}</p>
                  <p className="mt-1 text-[12px] text-ink-400">
                    {p.counterparty} · saved by {users[p.by].name} · {p.at}
                  </p>
                </div>
                {canApprove ? (
                  <span className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => onDiscard(p.id)}>
                      Discard
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => onApprove(p.id)}>
                      Approve
                    </Button>
                  </span>
                ) : (
                  <Tag className="bg-slate-100 text-ink-600">Waiting for Karandeep</Tag>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Counterparty, clause, outcome" />
        <select value={type} onChange={(e) => setType(e.target.value)} className={`${inputCls} sm:!w-56`}>
          <option value="all">All clause types</option>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <Segmented
          value={label}
          onChange={setLabel}
          options={[
            { value: 'all', label: 'All' },
            { value: 'standard', label: 'Standard' },
            { value: 'exception', label: 'Exceptions' },
          ]}
        />
      </div>
      {rows.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((p) => (
            <article key={p.id} className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,39,68,0.04)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-ink-500">{p.clauseType}</span>
                <LabelPill l={p.label} />
              </div>
              <p className="mt-3 text-[13px] text-ink-500">
                They asked for <span className="text-ink-800">{p.asked.toLowerCase()}</span>
              </p>
              <p className="mt-1 text-[16px] font-semibold leading-snug text-ink-900">{p.outcome}</p>
              <p className="mt-3 text-[13px] text-ink-500">
                {p.counterparty} · {p.date} · {p.context}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<Search size={20} />} title="No matching precedent">
            AtliQ hasn't negotiated this before, or it wasn't recorded. Decide on deal context, and the outcome will become precedent once approved.
          </EmptyState>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------- Audit ------------------------------- */

export function AuditLog({ audit }: { audit: AuditEntry[] }) {
  const [kind, setKind] = useState<'all' | AuditKind>('all')
  const rows = audit.filter((e) => kind === 'all' || e.kind === kind)
  const label: Record<AuditKind, string> = { human: 'Human', ai: 'AI', system: 'System', retrieval: 'Retrieval', delegation: 'Delegation' }
  const tone: Record<AuditKind, string> = {
    human: 'bg-brand-50 text-brand-700',
    ai: 'bg-risk-med-bg text-risk-med',
    system: 'bg-slate-100 text-ink-600',
    retrieval: 'bg-[#f1ecfd] text-[#5b34b8]',
    delegation: 'bg-risk-low-bg text-risk-low',
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" subtitle="AI outputs, evidence retrievals, human decisions, delegations and outcomes. Append-only." />
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: 'all', label: 'All' },
          { value: 'human', label: 'Human' },
          { value: 'ai', label: 'AI' },
          { value: 'system', label: 'System' },
          { value: 'retrieval', label: 'Retrievals' },
          { value: 'delegation', label: 'Delegation' },
        ]}
      />
      <Card flush>
        <ul className="-mt-3 divide-y divide-slate-100">
          {rows.map((e) => (
            <li key={e.id} className="grid gap-x-6 gap-y-1 px-6 py-4 sm:grid-cols-[150px_minmax(0,1fr)]">
              <div className="text-[13px] tabular-nums text-ink-400">{e.at}</div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-ink-900">{e.action}</span>
                  <Tag className={tone[e.kind]}>{label[e.kind]}</Tag>
                </div>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-600">{e.detail}</p>
                <p className="mt-0.5 text-[12px] text-ink-400">by {e.actor}</p>
              </div>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <EmptyState icon={<Inbox size={20} />} title="No events of this type yet" />}
      </Card>
    </div>
  )
}

/* -------------------------------- Team -------------------------------- */

export function Team({
  user,
  data,
  delegations,
  onDelegate,
  onRevoke,
}: {
  user: UserId
  data: Contract[]
  delegations: Delegation[]
  onDelegate: (d: Omit<Delegation, 'id' | 'created' | 'active'>) => void
  onRevoke: (id: string) => void
}) {
  const isKD = user === 'kd'
  const [to, setTo] = useState<UserId>('dhaval')
  const [scope, setScope] = useState<string>('all-routine')
  const [expires, setExpires] = useState(() => isoDay(new Date(Date.now() + 14 * 86_400_000)))
  const [range] = useState(() => ({ min: isoDay(new Date()), max: isoDay(new Date(Date.now() + 365 * 86_400_000)) }))
  const open = data.filter((c) => !['Signed', 'Rejected'].includes(c.status))
  const activeD = delegations.filter((d) => delegationActive(d))
  const past = delegations.filter((d) => !delegationActive(d))

  return (
    <div className="space-y-8">
      <PageHeader title="Team & delegation" subtitle="KD sees everything and signs. Everyone else sees only the contracts they're assigned to." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Delegations" subtitle="Approval rights handed over while KD is away. Signature always stays with KD.">
          {activeD.length === 0 ? (
            <p className="text-[14px] text-ink-500">No active delegations. Every approval waits for KD.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {activeD.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
                  <Avatar u={d.to} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold text-ink-900">
                      {users[d.to].name} · {d.scope === 'all-routine' ? 'all routine contracts' : d.scope.join(', ')}
                    </span>
                    <span className="text-[13px] text-ink-500">
                      Review and approval · until {d.expires}
                    </span>
                  </span>
                  {isKD && (
                    <Button variant="danger" size="sm" onClick={() => onRevoke(d.id)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {past.length > 0 && (
            <p className="mt-4 text-[13px] text-ink-400">
              Ended: {past.map((d) => `${users[d.to].name} (${d.active ? `expired ${d.expires}` : 'revoked'})`).join(', ')}
            </p>
          )}
        </Card>

        <Card title="Delegate approval">
          {isKD ? (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                onDelegate({
                  to,
                  scope: scope === 'all-routine' ? 'all-routine' : [scope],
                  rights: 'Review and approval',
                  expires: pickerToDay(expires),
                })
              }}
            >
              <LabelledInput label="Hand over to">
                <select value={to} onChange={(e) => setTo(e.target.value as UserId)} className={inputCls}>
                  {userIds
                    .filter((u) => u !== 'kd')
                    .map((u) => (
                      <option key={u} value={u}>
                        {users[u].name}
                      </option>
                    ))}
                </select>
              </LabelledInput>
              <LabelledInput label="For">
                <select value={scope} onChange={(e) => setScope(e.target.value)} className={inputCls}>
                  <option value="all-routine">All routine (non-high-value) contracts</option>
                  {open.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.counterparty} - {c.docType}
                    </option>
                  ))}
                </select>
              </LabelledInput>
              <LabelledInput label="Until">
                <input type="date" value={expires} min={range.min} max={range.max} onChange={(e) => setExpires(e.target.value)} className={inputCls} required />
              </LabelledInput>
              <Button type="submit" variant="primary" className="w-full">
                Delegate
              </Button>
            </form>
          ) : (
            <p className="text-[14px] text-ink-500">Only Karandeep can grant or revoke delegation.</p>
          )}
        </Card>
      </div>

      <Card title="People" flush>
        <ul className="divide-y divide-slate-100">
          {userIds.map((u) => {
            const d = activeD.some((x) => x.to === u)
            const perms = users[u].superAdmin
              ? ['All contracts', 'Approve', 'Sign', 'Delegate']
              : ['Assigned contracts', 'Comment & re-grade', ...(d ? ['Approve (delegated)'] : [])]
            return (
              <li key={u} className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6">
                <Avatar u={u} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink-900">
                    {users[u].name}
                    {u === user && <span className="ml-1.5 font-normal text-ink-400">(you)</span>}
                  </p>
                  <p className="text-[13px] text-ink-500">{users[u].title}</p>
                </div>
                <p className="text-[13px] text-ink-600">{perms.join(' · ')}</p>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A local date as the picker's "2027-09-05". */
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "2027-09-05" → "05 Sep 2027", read as written: no time zone involved. */
function pickerToDay(v: string) {
  const [y, m, d] = v.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`
}

/* ------------------------------- Submit ------------------------------ */

const STEPS = [
  'Reading the document and scoring scan quality',
  'Identifying document type and AtliQ’s role',
  'Linking to a parent agreement, if any',
  'Splitting into clauses and extracting terms',
  'Checking legal entity and jurisdiction',
  'Retrieving precedent and live obligations',
  'Comparing terms and checking expiry dates',
  'Screening brand exposure and payment history',
  'Verifying every quote against the source',
  'Writing the review',
]

export interface SubmitPrefill {
  fromId: string
  counterparty: string
  country: string
  docType: string
  direction: 'inbound' | 'outbound'
}

const DOC_GUESS: [RegExp, string][] = [
  [/(?<![a-z])nda(?![a-z])|non.?disclosure/i, 'NDA'],
  [/(?<![a-z])sow(?![a-z])|statement.of.work/i, 'SOW'],
  [/(?<![a-z])msa(?![a-z])|master.services/i, 'MSA'],
  [/(?<![a-z])dpa(?![a-z])|data.processing/i, 'DPA'],
  [/(?<![a-z])baa(?![a-z])/i, 'BAA'],
  [/partner/i, 'Partnership'],
]

export function Submit({
  onDone,
  onOpen,
  onFinished,
  user,
  online,
  prefill,
}: {
  onDone: () => void
  onOpen: (id: string) => void
  onFinished: (fileName: string, contractId: string | null) => void
  user: UserId
  online: boolean
  prefill?: SubmitPrefill
}) {
  const [started, setStarted] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<'inbound' | 'outbound'>(prefill?.direction ?? 'inbound')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [docType, setDocType] = useState(prefill?.docType ?? 'MSA')
  // G1 — the capabilities card opens on arrival, then tucks itself away after a minute.
  // Reopening it with "Show" keeps it open.
  const [capsOpen, setCapsOpen] = useState(!prefill)
  const capsTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (prefill) return
    capsTimer.current = window.setTimeout(() => setCapsOpen(false), 60_000)
    return () => clearTimeout(capsTimer.current)
  }, [prefill])
  const [guess, setGuess] = useState<{ type: string; conf: number; answered: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const typeRef = useRef<HTMLSelectElement>(null)
  const notified = useRef(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState('')
  const [newId, setNewId] = useState<string | null>(null)
  const stage = !started ? 'form' : step >= STEPS.length ? 'done' : 'running'

  // G3 — tell the user when the review is ready, wherever they are.
  useEffect(() => {
    if (stage === 'done' && !notified.current) {
      notified.current = true
      onFinished(file?.name ?? 'contract', newId)
    }
  }, [stage, file, onFinished, newId])

  // Offline demo only: simulate progress. Online, progress comes from the server's job.
  useEffect(() => {
    if (stage !== 'running' || online) return
    const t = setTimeout(() => setStep((s) => s + 1), 380)
    return () => clearTimeout(t)
  }, [stage, step, online])

  function accept(f?: File) {
    if (!f) return
    if (!/\.(pdf|docx|txt|md)$/i.test(f.name)) {
      setFileError(`“${f.name}” isn't supported. Upload a PDF, DOCX, Markdown or TXT file.`)
      setFile(null)
      return
    }
    if (f.size > 25 * 1024 * 1024) {
      setFileError('That file is over 25 MB. Contracts up to ~100 pages are supported.')
      setFile(null)
      return
    }
    setFileError('')
    setFile(f)
    // G10 — say what it thinks the document is, and ask when unsure.
    const hit = DOC_GUESS.find(([re]) => re.test(f.name))
    const g = hit ? { type: hit[1], conf: 0.93, answered: false } : { type: 'MSA', conf: 0.62, answered: false }
    setGuess(g)
    if (g.conf >= 0.85) setDocType(g.type)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="New review" subtitle="English contracts up to 100 pages. Analysis usually takes under a minute." />

      {prefill && (
        <Banner tone="info" title={`Revised draft for ${prefill.counterparty}`}>
          Details are copied from {prefill.fromId}. The new review is linked to the previous one so you can compare them.
        </Banner>
      )}

      {/* G1 — set expectations before the first upload */}
      <details className="group rounded-xl border border-slate-200/80 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,39,68,0.04)]"
        open={capsOpen}
        onToggle={(e) => setCapsOpen(e.currentTarget.open)}
      >
        <summary
          onClick={() => clearTimeout(capsTimer.current)}
          className="flex cursor-pointer list-none items-center justify-between text-[14px] font-semibold text-ink-900 [&::-webkit-details-marker]:hidden"
        >
          What the assistant will and won't do
          <span className="text-[13px] font-medium text-brand-600 group-open:hidden">Show</span>
          <span className="hidden text-[13px] font-medium text-brand-600 group-open:inline">Hide</span>
        </summary>
        <div className="mt-4">
          <Capabilities compact />
        </div>
      </details>

      {stage === 'form' && (
        <form
          className="space-y-6"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!online) {
              setStep(0)
              setStarted(true)
              return
            }
            const fd = new FormData(e.currentTarget)
            fd.append('file', file!)
            fd.set('direction', direction)
            fd.set('doc_type', docType)
            fd.set('primary', user)
            if (prefill) fd.set('parent_id', prefill.fromId)
            setBusy(true)
            setServerError('')
            try {
              const { jobId, contractId } = await api.upload(fd)
              setStep(0)
              setStarted(true)
              const job = await waitForJob(jobId, (s) => setStep(Math.min(s, STEPS.length - 1)))
              if (job.status === 'done') {
                setNewId(contractId)
                setStep(STEPS.length)
              } else {
                setStarted(false)
                setServerError(job.error ?? 'The analysis failed. Try again.')
              }
            } catch (err) {
              setStarted(false)
              setServerError((err as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-[13px] font-medium text-ink-800">What are you reviewing?</legend>
            {(
              [
                ['inbound', 'A contract we received', 'From a client or partner', ArrowDownLeft],
                ['outbound', 'Our own draft', 'Check it before sending', ArrowUpRight],
              ] as const
            ).map(([v, title, sub, Icon]) => (
              <label
                key={v}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-white p-4 transition ${
                  direction === v ? 'border-brand-600 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <input type="radio" name="dir" className="sr-only" checked={direction === v} onChange={() => setDirection(v)} />
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${direction === v ? 'bg-brand-600 text-white' : 'bg-slate-100 text-ink-500'}`}>
                  <Icon size={17} />
                </span>
                <span>
                  <span className="block text-[14px] font-semibold text-ink-900">{title}</span>
                  <span className="block text-[13px] text-ink-500">{sub}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                accept(e.dataTransfer.files[0])
              }}
              className={`grid w-full place-items-center rounded-xl border-2 border-dashed px-4 py-10 text-center transition ${
                dragging ? 'border-brand-500 bg-brand-50' : file ? 'border-risk-low/40 bg-risk-low-bg/50' : 'border-slate-300 bg-white hover:border-brand-500'
              }`}
            >
              {file ? (
                <span className="flex items-center gap-3 text-left">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-white text-risk-low shadow-sm">
                    <FileText size={20} />
                  </span>
                  <span>
                    <span className="block text-[14px] font-semibold text-ink-900">{file.name}</span>
                    <span className="block text-[13px] text-ink-500">
                      {Math.max(1, Math.round(file.size / 1024))} KB · click to replace
                    </span>
                  </span>
                </span>
              ) : (
                <>
                  <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-50 text-brand-600">
                    <UploadCloud size={22} />
                  </span>
                  <p className="mt-3 text-[14px] font-semibold text-ink-900">Drop the contract here</p>
                  <p className="mt-0.5 text-[13px] text-ink-500">
                    or <span className="font-medium text-brand-600">browse</span> · PDF, DOCX, Markdown or TXT
                  </p>
                </>
              )}
            </button>
            {fileError && <p className="mt-2 text-[13px] text-risk-high">{fileError}</p>}
            {file && guess && (
              guess.conf >= 0.85 ? (
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-600">
                  <Sparkles size={14} className="text-ink-400" /> Looks like an {guess.type} ({Math.round(guess.conf * 100)}% sure). Document type set below.
                  You can change it.
                </p>
              ) : !guess.answered ? (
                <div className="animate-fade-in mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-risk-med-bg px-4 py-3 text-[13px] text-ink-800">
                  <Sparkles size={15} className="shrink-0 text-risk-med" />
                  <span className="min-w-0 flex-1">
                    Not sure what this is. It looks most like an <strong>{guess.type}</strong> ({Math.round(guess.conf * 100)}% sure). Is that right?
                  </span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setDocType(guess.type)
                      setGuess({ ...guess, answered: true })
                    }}
                  >
                    Yes, it's an {guess.type}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setGuess({ ...guess, answered: true })
                      typeRef.current?.focus()
                    }}
                  >
                    No, I'll choose
                  </Button>
                </div>
              ) : null
            )}
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => accept(e.target.files?.[0])} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <LabelledInput label="Counterparty">
              <input name="counterparty" className={inputCls} placeholder="e.g. Northwind Health Inc." defaultValue={prefill?.counterparty} required pattern=".*\S.*" title="Enter the counterparty" />
            </LabelledInput>
            <LabelledInput label="Their country">
              <input name="country" className={inputCls} placeholder="e.g. United States" defaultValue={prefill?.country} required pattern=".*\S.*" title="Enter their country" />
            </LabelledInput>
            <LabelledInput label="Document type">
              <select ref={typeRef} className={inputCls} value={docType} onChange={(e) => setDocType(e.target.value)}>
                {['NDA', 'MSA', 'SOW', 'DPA', 'BAA', 'Partnership', 'Other'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </LabelledInput>
            <LabelledInput label="Deal value" hint="optional, in US dollars">
              <input name="value" className={inputCls} placeholder="e.g. $480,000 or $1.2M" />
            </LabelledInput>
            {docType === 'SOW' && (
              <div className="sm:col-span-2">
                <LabelledInput label="Parent agreement">
                  <select name="parent_id" className={inputCls} defaultValue="">
                    <option value="">Find it automatically from agreements on file</option>
                  </select>
                </LabelledInput>
              </div>
            )}
          </div>

          {serverError && (
            <Banner tone="danger" title="The review couldn't run">
              {serverError}
            </Banner>
          )}
          <div className="flex flex-wrap items-center justify-end gap-4 border-t border-slate-200 pt-5">
            <Button type="submit" variant="primary" size="lg" disabled={!file || busy} title={!file ? 'Add a file first' : undefined}>
              {busy ? 'Uploading…' : 'Run review'}
            </Button>
          </div>
        </form>
      )}

      {stage !== 'form' && (
        <Card>
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100 text-ink-600">
              <FileText size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold text-ink-900">{file?.name}</p>
              <p className="text-[13px] text-ink-500">{stage === 'done' ? 'Analysis complete' : `Step ${step + 1} of ${STEPS.length}`}</p>
            </div>
          </div>
          <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand-600 transition-all duration-300" style={{ width: `${(Math.min(step, STEPS.length) / STEPS.length) * 100}%` }} />
          </div>
          <ul className="space-y-2.5">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex items-center gap-3 text-[14px] ${i < step ? 'text-ink-500' : i === step ? 'font-medium text-ink-900' : 'text-ink-300'}`}>
                {i < step ? (
                  <Check size={16} className="shrink-0 text-risk-low" />
                ) : i === step ? (
                  <Loader2 size={16} className="shrink-0 animate-spin text-brand-600" />
                ) : (
                  <span className="mx-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                )}
                {s}
              </li>
            ))}
          </ul>
          {stage === 'done' && (
            <div className="mt-6 space-y-4">
              <Banner tone="ok" title="Review ready">
                {newId
                  ? 'Findings, quotes and clause coverage are ready for review. Nothing has been approved or signed.'
                  : "Offline demo: this upload isn't analysed. Open the queue to explore the sample reviews. Nothing has been approved or signed."}
              </Banner>
              <Button variant="primary" className="w-full" onClick={() => (newId ? onOpen(newId) : onDone())}>
                {newId ? 'Open the review' : 'Go to contract reviews'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
