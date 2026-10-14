// Types and helpers for the AtliQ Contract Risk Analyzer (PRD v1.1).
// The data itself comes from the API (built from Project/Dataset); src/seed.json is the offline fallback.
// §5 personas, §7 FR-1…FR-22, §10.1 output per review, §10.2 behaviour states,
// §14.3 priority risk categories, FR-13/14 dated obligation register.

export type Severity = 'high' | 'medium' | 'low' | 'unknown'
export type ReviewState =
  | 'green'
  | 'amber'
  | 'red'
  | 'insufficient-evidence'
  | 'conflicting-evidence'
export type Disposition =
  | 'proceed'
  | 'negotiate'
  | 'internal-confirmation'
  | 'counsel'
  | 'do-not-sign'
  | 'no-verdict'
export type FindingAction =
  | 'accept'
  | 'negotiate'
  | 'seek-internal-confirmation'
  | 'escalate-to-counsel'
  | 'reject'
export type HumanDecision = 'pending' | 'accepted' | 'modified' | 'rejected' | 'escalated'
export type ContractStatus =
  | 'Analyzing'
  | 'Awaiting review'
  | 'In negotiation'
  | 'Internal confirmation'
  | 'With counsel'
  | 'Ready to sign'
  | 'Signed'
  | 'Rejected'

/* ------------------------------ people ------------------------------ */

export type UserId = 'kd' | 'bhavin' | 'dhaval' | 'jay'

export interface User {
  id: UserId
  name: string
  short: string
  initials: string
  title: string
  /** FR-18 — CEO is super-admin; others see only contracts they are entitled to. */
  superAdmin: boolean
  /** §17 #9 — until confirmed in writing, signature stays with KD. */
  canSign: boolean
}

export const users: Record<UserId, User> = {
  kd: { id: 'kd', name: 'Karandeep', short: 'KD', initials: 'KD', title: 'CEO · super-admin · signatory', superAdmin: true, canSign: true },
  bhavin: { id: 'bhavin', name: 'Bhavin', short: 'Bhavin', initials: 'BH', title: 'Founder · reviewer', superAdmin: false, canSign: false },
  dhaval: { id: 'dhaval', name: 'Dhaval', short: 'Dhaval', initials: 'DH', title: 'Founder · reviewer', superAdmin: false, canSign: false },
  jay: { id: 'jay', name: 'Jay', short: 'Jay', initials: 'JY', title: 'Sales · reviewer', superAdmin: false, canSign: false },
}

export const userIds: UserId[] = ['kd', 'bhavin', 'dhaval', 'jay']

/** FR-16 — named delegate, defined scope, expiry; recorded in the audit trail. */
export interface Delegation {
  id: string
  to: UserId
  /** 'all-routine' = every contract the delegate can see that is not high-value. */
  scope: string[] | 'all-routine'
  rights: 'Review and approval'
  created: string
  expires: string
  active: boolean
}


/* ----------------------------- contracts ----------------------------- */

/** §14.3 — priority order, not a filter. FR-21 still requires every clause be examined. */
export const RISK_CATEGORIES = [
  'Liability caps and carve-outs',
  'Indemnity',
  'Liquidated damages / delay penalties',
  'Payment terms',
  'Governing law / dispute resolution',
  'IP ownership and reuse',
  'Termination and payment for work performed',
  'Confidentiality / NDA mutuality',
  'Non-compete / exclusivity',
  'Most-favoured-customer / pricing promises',
  'Data protection / BAA / DPA dependencies',
  'Entity and signing-party mismatch',
  'SOW/proposal alignment',
  'Brand and reputational exposure',
  'Embedded instructions (prompt injection)',
] as const
export type RiskCategory = (typeof RISK_CATEGORIES)[number]

export interface Citation {
  /** Exact quoted span from the parsed source — FR-10, eval: citation faithfulness. */
  quote: string
  page: number
  section: string
}

export interface PrecedentRef {
  contract: string
  counterparty: string
  date: string
  outcome: string
  /** Guardrail §11 — one-off exceptions never become policy. */
  label: 'standard' | 'exception' | 'unknown'
}

/** FR-17 — primary and secondary reviewers comment and re-grade independently. */
export interface ReviewerMark {
  by: UserId
  as: 'primary' | 'secondary'
  verdict: 'agree' | 'regrade' | 'comment'
  regradeTo?: Severity
  comment: string
  at: string
}

export interface Finding {
  id: string
  clauseTitle: string
  category: RiskCategory
  severity: Severity
  whyItMatters: string
  citation: Citation
  confidence: number
  recommendedAction: FindingAction
  precedents: PrecedentRef[]
  /** FR-9 — grounded in cited precedent, always a draft for human review. */
  suggestedFallback?: { text: string; basis: string; label: 'standard' | 'exception' }
  marks: ReviewerMark[]
  decision: HumanDecision
  decidedBy?: UserId
  abstained?: boolean
  abstentionReason?: string
  /* HAX additions — all set by people, never by the model */
  /** G15 — granular feedback on the finding itself. */
  feedback?: { useful: boolean; reason?: string; by: UserId }
  /** G15 — feedback on the suggested wording. */
  wordingFeedback?: 'usable' | 'edited' | 'unusable'
  /** G9 — wording edited by the approver; the AI original is kept. */
  editedFallback?: { text: string; by: UserId }
  /** G8 — reason given when dismissed as "not an issue". */
  dismissReason?: string
  /** G9 — approver's corrected severity; the AI grade is kept for audit. */
  severityOverride?: { to: Severity; by: UserId }
  /** G11 — clause facts behind the grade (set by the backend for uploaded contracts). */
  drivers?: string[]
}

export type ObligationStatus = 'active' | 'expired' | 'superseded'

export interface ConflictItem {
  id: string
  newClause: Citation
  prior: {
    obligationId: string
    contract: string
    counterparty: string
    effective: string
    expires: string
    quote: string
    /** FR-7 — every conflict states live / expired / superseded and the date it relies on. */
    status: ObligationStatus
    reliesOn: string
    sourceFile?: string
    clause?: string
  }
  explanation: string
  severity: Severity
}

export interface EntityCheck {
  namedEntity: string
  expectedEntity: string
  clientLocation: string
  governingLaw: string
  invoicingConsistent: boolean
  signatoryValid: boolean
  status: 'pass' | 'fail'
  rule: string
  note: string
}

/** FR-19 — brand and reputational exposure. */
export interface BrandItem {
  type: 'Publicity and reference rights' | 'Asymmetric non-disparagement' | 'Conduct or association'
  severity: Severity
  citation: Citation
  note: string
}

/** FR-20 — from AtliQ's own records; never imply a clean record when none is held. */
export interface Legitimacy {
  held: boolean
  summary: string
  source: string
  events: { date: string; kind: 'On time' | 'Missed cycle' | 'Payment default' | 'Dispute'; detail: string }[]
}

export interface MissingInfo {
  id: string
  question: string
  /** FR-12 — routed to Finance, CTO or the assigned reviewer. */
  owner: 'Finance' | 'CTO' | 'Assigned reviewer'
  assignee?: UserId
  blocking: boolean
  resolved: boolean
}

/** FR-22 — contract family. */
export interface Family {
  relation: string
  parent?: { name: string; signed: string; id?: string }
  orphan?: boolean
  note: string
}

export interface ClauseRow {
  section: string
  title: string
  /** Clause text, so a reviewer can check every quote against the source. */
  text?: string
  outcome: 'finding' | 'no-issue' | 'not-covered'
}

export interface Contract {
  id: string
  name: string
  counterparty: string
  docType: string
  /** §10.2 — how the document is presented. Never alters review depth. */
  presentedAs?: string
  /** FR-1 — inbound from counterparty, or an AtliQ-authored draft before sending. */
  direction: 'inbound' | 'outbound'
  receivedFrom: string
  atliqRole: 'Supplier' | 'Buyer' | 'Partner' | 'NDA party'
  entity: string
  country: string
  value: string
  highValue: boolean
  received: string
  pages: number
  status: ContractStatus
  state: ReviewState
  disposition: Disposition
  summary: string
  parseQuality: number
  primary: UserId
  secondary?: UserId
  /** FR-18 — who may open this contract (KD always can). */
  access: UserId[]
  family?: Family
  clauses: ClauseRow[]
  coverageThreshold: number
  findings: Finding[]
  conflicts: ConflictItem[]
  entityCheck: EntityCheck
  brand: BrandItem[]
  legitimacy: Legitimacy
  missingInfo: MissingInfo[]
  injection?: { page: number; note: string }
  /** G9/G10 — a person confirmed or corrected the AI-detected document details. */
  detailsCheckedBy?: { by: UserId; corrected: boolean }
  /** G10 — classifier confidence for type/role/entity (set by the backend). */
  detectConfidence?: number
  /** The dataset file this review was built from. */
  sourceFile?: string
  /** Context from contract_tracker.csv — shown to people, never used for grading (PRD §8.2). */
  dealContext?: DealContext
  asOf?: string
  audit: {
    model: string
    promptVersion: string
    rulesVersion: string
    sourcesUsed: number
    overallConfidence: number
    completedAt: string
    durationSeconds: number
  }
}

/* ------------------------- obligation register ------------------------- */

export interface Obligation {
  id: string
  clauseType: string
  counterparty: string
  sourceContract: string
  entity: string
  effective: string
  expires: string
  status: ObligationStatus
  basis: 'standard' | 'exception'
  summary: string
  supersededBy?: string
  sourceFile?: string
  clause?: string
  quote?: string
}


/* ------------------------------ precedent ------------------------------ */

export interface Precedent {
  id: string
  clauseType: string
  counterparty: string
  contract: string
  date: string
  asked: string
  outcome: string
  label: 'standard' | 'exception' | 'unknown'
  context: string
}


/* ------------------------------ audit trail ------------------------------ */

export interface DealContext {
  trackerId: string
  requestedBy: string
  received?: string | null
  due?: string | null
  notes?: string
  trackerStatus?: string
  fileLocation?: string | null
  /** The file's own note on where it came from, e.g. "Client draft received … via Bhavin's email." */
  provenance?: string
  signed?: string | null
  expires?: string | null
}

/** A problem found in contract_tracker.csv during import. */
export interface DataQualityIssue {
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  rows: string[]
}

export type AuditKind = 'ai' | 'human' | 'system' | 'retrieval' | 'delegation'

export interface AuditEntry {
  id: string
  at: string
  actor: string
  action: string
  detail: string
  kind: AuditKind
}


/* ------------------------------ helpers ------------------------------ */

export const severityLabel: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Needs judgement',
}

export const stateLabel: Record<ReviewState, string> = {
  green: 'Low risk',
  amber: 'Negotiable',
  red: 'High risk',
  'insufficient-evidence': 'Insufficient evidence',
  'conflicting-evidence': 'Conflicting evidence',
}

export const dispositionLabel: Record<Disposition, string> = {
  proceed: 'Proceed to human approval',
  negotiate: 'Negotiate',
  'internal-confirmation': 'Internal confirmation required',
  counsel: 'Counsel required',
  'do-not-sign': 'Do not sign yet',
  'no-verdict': 'No verdict issued',
}

export const actionLabel: Record<FindingAction, string> = {
  accept: 'Accept',
  negotiate: 'Negotiate',
  'seek-internal-confirmation': 'Seek internal confirmation',
  'escalate-to-counsel': 'Escalate to counsel',
  reject: 'Reject',
}

export function coverage(c: Contract) {
  const total = c.clauses.length
  const flagged = c.clauses.filter((r) => r.outcome === 'finding').length
  const noIssue = c.clauses.filter((r) => r.outcome === 'no-issue').length
  const notCovered = c.clauses.filter((r) => r.outcome === 'not-covered').length
  const pct = total ? (total - notCovered) / total : 0
  return { total, flagged, noIssue, notCovered, pct, below: pct < c.coverageThreshold }
}

export function openHighSeverity(c: Contract): number {
  return c.findings.filter((f) => f.severity === 'high' && f.decision === 'pending').length
}

export function liveConflicts(c: Contract) {
  return c.conflicts.filter((x) => x.prior.status === 'active')
}

/** §10.2 / §11 — reasons ready-to-sign is blocked. Never auto-cleared. */
export function blockReasons(c: Contract): string[] {
  const r: string[] = []
  const cov = coverage(c)
  if (cov.below) r.push(`Clause coverage ${Math.round(cov.pct * 100)}% is below the ${Math.round(c.coverageThreshold * 100)}% threshold`)
  const highs = openHighSeverity(c)
  if (highs) r.push(`${highs} high-severity finding${highs > 1 ? 's' : ''} not yet dispositioned`)
  const live = liveConflicts(c).length
  if (live) r.push(`${live} conflict${live > 1 ? 's' : ''} with a live obligation`)
  if (c.entityCheck.status === 'fail') r.push('Legal entity check failed')
  if (c.family?.orphan) r.push('Parent agreement not located')
  if (c.missingInfo.some((m) => m.blocking && !m.resolved)) r.push('Blocking questions still open')
  return r
}

export function visibleTo(c: Contract, u: UserId) {
  return users[u].superAdmin || c.access.includes(u)
}

const DELEGATION_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Same rule as the server (api/app/access.py delegation_active): not revoked, and today is on or
 *  before the expiry date ("05 Sep 2027"). An unreadable date counts as ended, never open-ended. */
export function delegationActive(d: Delegation, today: Date = new Date()) {
  if (!d.active) return false
  const [day, mon, year] = d.expires.split(' ')
  const m = DELEGATION_MONTHS.indexOf((mon ?? '').slice(0, 3))
  const end = new Date(Number(year), m, Number(day))
  if (m < 0 || Number.isNaN(end.getTime())) return false
  return end >= new Date(today.getFullYear(), today.getMonth(), today.getDate())
}

export function delegationFor(c: Contract, u: UserId, ds: Delegation[]) {
  return ds.find(
    (d) =>
      delegationActive(d) && d.to === u && (d.scope === 'all-routine' ? !c.highValue && c.access.includes(u) : d.scope.includes(c.id)),
  )
}

/** Approver is KD unless an active delegation covers this contract. */
export function approverOf(c: Contract, ds: Delegation[]): { user: UserId; delegation?: Delegation } {
  for (const u of userIds) {
    if (u === 'kd') continue
    const d = delegationFor(c, u, ds)
    if (d) return { user: u, delegation: d }
  }
  return { user: 'kd' }
}

export function canApprove(c: Contract, u: UserId, ds: Delegation[]) {
  return u === 'kd' || !!delegationFor(c, u, ds)
}

export function reviewerRole(c: Contract, u: UserId): 'primary' | 'secondary' | null {
  if (c.primary === u) return 'primary'
  if (c.secondary === u) return 'secondary'
  return null
}

