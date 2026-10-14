// Typed client for the FastAPI backend in Project/api (proxied at /api by Vite).
import type { AuditEntry, Contract, DataQualityIssue, ContractStatus, Delegation, Finding, HumanDecision, Obligation, Precedent, Severity, UserId } from './data'
import type { PendingPrecedent } from './hax'

export interface Bootstrap {
  contracts: Contract[]
  hidden: number
  delegations: Delegation[]
  obligations: Obligation[]
  precedents: Precedent[]
  pending: PendingPrecedent[]
  audit: AuditEntry[]
  ai: 'claude' | 'rules'
  asOf?: string
  dataQuality?: DataQualityIssue[]
}

export interface Job {
  id: string
  contractId: string
  step: number
  total: number
  status: 'running' | 'done' | 'error'
  error: string | null
}

export interface FindingPatch {
  decision?: HumanDecision
  severityOverride?: Severity | null
  editedFallback?: string | null
  dismissReason?: string
  feedback?: { useful: boolean; reason?: string } | null
  wordingFeedback?: NonNullable<Finding['wordingFeedback']>
  mark?: { verdict: 'agree' | 'regrade' | 'comment'; regradeTo?: Severity; comment: string }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let currentUser: UserId = 'kd'
export function setApiUser(u: UserId) {
  currentUser = u
}

/** Where the API lives. Empty locally (Vite proxies /api to :8000); the hosted web app sets
 *  VITE_API_URL to the hosted API, e.g. https://atliq-api.onrender.com */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = init.body && !(init.body instanceof FormData)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      headers: { 'X-User': currentUser, ...(json ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch {
    throw new ApiError(0, 'The review server is not reachable.')
  }
  if (!res.ok) {
    let msg = res.statusText
    try {
      const d = (await res.json()).detail
      msg =
        typeof d === 'string'
          ? d
          : d?.reasons
            ? `${d.message}: ${d.reasons.join('; ')}`
            : Array.isArray(d) // FastAPI validation errors: [{ msg: "Value error, Write a comment", ... }]
              ? d.map((x: { msg?: string }) => (x.msg ?? '').replace(/^Value error, /, '')).join('; ')
              : (d?.message ?? JSON.stringify(d))
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  health: () => req<{ ok: boolean; ai: string; rules: string }>('/health'),
  bootstrap: () => req<Bootstrap>('/bootstrap'),
  contract: (id: string) => req<Contract>(`/contracts/${id}`),
  audit: () => req<AuditEntry[]>('/audit'),
  obligations: () => req<Obligation[]>('/obligations'),
  precedents: () => req<Precedent[]>('/precedents'),

  patchFinding: (cid: string, fid: string, body: FindingPatch) =>
    req<Contract>(`/contracts/${cid}/findings/${fid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setStatus: (cid: string, status: ContractStatus, note: string) => post<Contract>(`/contracts/${cid}/status`, { status, note }),
  resolve: (cid: string, mid: string) => post<Contract>(`/contracts/${cid}/questions/${mid}/resolve`),
  details: (cid: string, body: Partial<Pick<Contract, 'docType' | 'atliqRole' | 'entity' | 'country'>>) => post<Contract>(`/contracts/${cid}/details`, body),
  rerun: (cid: string) => post<{ contract?: Contract; jobId?: string; contractId?: string }>(`/contracts/${cid}/rerun`),

  upload: (form: FormData) => req<{ jobId: string; contractId: string }>('/contracts', { method: 'POST', body: form }),
  job: (id: string) => req<Job>(`/jobs/${id}`),

  delegate: (body: { to: UserId; scope: string[] | 'all-routine'; expires: string }) => post<Delegation[]>('/delegations', body),
  revoke: (id: string) => post<Delegation[]>(`/delegations/${id}/revoke`),

  savePending: (contractId: string, findingId: string, label: 'standard' | 'exception') =>
    post<PendingPrecedent>('/pending-precedents', { contractId, findingId, label }),
  approvePending: (id: string) => post<PendingPrecedent[]>(`/pending-precedents/${id}/approve`),
  discardPending: (id: string) => post<PendingPrecedent[]>(`/pending-precedents/${id}/discard`),
}

/** Polls a job until it finishes. Calls onStep with progress; resolves with the final job. */
export async function waitForJob(id: string, onStep: (step: number) => void): Promise<Job> {
  for (;;) {
    const j = await api.job(id)
    onStep(j.step)
    if (j.status !== 'running') return j
    await new Promise((r) => setTimeout(r, 350))
  }
}
