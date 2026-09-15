"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  decideNovaApproval,
  executeNovaSkill,
  getNovaRun,
  listBrands,
  listNovaRuns,
  listNovaSkills,
  publishNovaRun,
} from "@/lib/api/nova";
import { listCollections } from "@/lib/api/knowledge";
import { CoreApiError } from "@/lib/api/client";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusPill } from "@/components/ui";
import { HashValue } from "@/components/HashValue";
import { connectorStateLabel, formatTime } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";
import { useSession } from "@/lib/session";
import { can } from "@/lib/permissions";
import type { NovaExecuteResult, NovaRunDetail } from "@/lib/api/types";

const SKILL_TABS = [
  { id: "nova.research", label: "Research" },
  { id: "nova.drafting", label: "Drafting" },
  { id: "nova.social.draft", label: "Social Draft" },
] as const;

export default function NovaPage() {
  const { me } = useSession();
  const skills = useAsync(() => listNovaSkills(), []);
  const runs = useAsync(() => listNovaRuns(), []);
  const collections = useAsync(() => listCollections(), []);
  const brands = useAsync(() => listBrands(), []);
  const [skillId, setSkillId] = useState<(typeof SKILL_TABS)[number]["id"]>("nova.research");
  const [result, setResult] = useState<NovaExecuteResult | null>(null);
  const [detail, setDetail] = useState<NovaRunDetail | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftEdit, setDraftEdit] = useState<string | null>(null);

  const sealed = result?.artifact ?? detail?.social_item?.draft_text ?? "";
  const unsealed = draftEdit !== null && draftEdit !== sealed;

  async function loadRun(executionId: string) {
    const next = await getNovaRun(executionId);
    setDetail(next);
    return next;
  }

  async function runSkill(input: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setDraftEdit(null);
    try {
      const executed = await executeNovaSkill(skillId, input);
      setResult(executed);
      await loadRun(executed.execution_id);
      await runs.reload();
    } catch (err) {
      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "execution failed", 500));
    } finally {
      setBusy(false);
    }
  }

  const governance = useMemo(() => {
    const status = result?.status ?? detail?.execution.status;
    return { status, recordId: result?.verity_record_id ?? detail?.execution.verity_record_id };
  }, [result, detail]);

  return (
    <div>
      <PageHeader title="Nova" description="Operator workspace. Skills execute through Core; this browser never calls Nova internally." />
      {skills.loading ? <LoadingState label="Loading skills" /> : null}
      {skills.error ? <ErrorState message={skills.error.message} requestId={skills.error.requestId} onRetry={() => void skills.reload()} /> : null}
      <div className="grid gap-4 xl:grid-cols-[220px_1fr_280px]">
        <Panel>
          <h2 className="text-sm font-semibold">Recent runs</h2>
          {runs.loading ? <LoadingState label="Loading runs" /> : null}
          {runs.data?.runs.length === 0 ? (
            <EmptyState title="No runs" body="Execute a skill to populate this list." />
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {runs.data?.runs.map((run) => (
                <li key={run.execution_id}>
                  <button
                    type="button"
                    className="w-full text-left hover:underline"
                    onClick={() => {
                      setResult(null);
                      void loadRun(run.execution_id);
                    }}
                  >
                    <span className="block font-medium">{run.skill_id}</span>
                    <span className="text-xs text-muted">{run.status} · {formatTime(run.started_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="space-y-4">
          <div className="flex gap-2" role="tablist" aria-label="Nova skills">
            {SKILL_TABS.filter((tab) => skills.data?.skills.some((s) => s.id === tab.id) ?? true).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={skillId === tab.id}
                className={`btn ${skillId === tab.id ? "btn-primary" : ""}`}
                onClick={() => {
                  setSkillId(tab.id);
                  setResult(null);
                  setDraftEdit(null);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {skillId === "nova.research" ? (
            <ResearchForm
              collections={collections.data?.collections ?? []}
              busy={busy}
              onSubmit={(input) => void runSkill(input)}
            />
          ) : null}
          {skillId === "nova.drafting" ? (
            <DraftingForm
              collections={collections.data?.collections ?? []}
              busy={busy}
              onSubmit={(input) => void runSkill(input)}
            />
          ) : null}
          {skillId === "nova.social.draft" ? (
            <SocialForm
              collections={collections.data?.collections ?? []}
              brands={brands.data?.brands ?? []}
              busy={busy}
              onSubmit={(input) => void runSkill(input)}
            />
          ) : null}
          {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
          <ResultPane
            result={result}
            detail={detail}
            skillId={skillId}
            unsealed={unsealed}
            draftEdit={draftEdit}
            sealed={sealed}
            onEdit={setDraftEdit}
            canApprove={can(me?.permissions, "approvals.decide")}
            onDecide={async (allow) => {
              if (!detail?.approval?.id || !detail.approval.artifact_hash) return;
              setBusy(true);
              try {
                await decideNovaApproval(detail.execution.id, detail.approval.id, allow, detail.approval.artifact_hash);
                await loadRun(detail.execution.id);
              } catch (err) {
                setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "decision failed", 500));
              } finally {
                setBusy(false);
              }
            }}
            onPublish={async (action, scheduledFor) => {
              if (!detail?.social_item) return;
              setBusy(true);
              try {
                await publishNovaRun(detail.execution.id, {
                  action,
                  scheduled_for: scheduledFor,
                  artifact_hash: detail.social_item.artifact_hash,
                  message: detail.social_item.draft_text,
                });
                await loadRun(detail.execution.id);
              } catch (err) {
                setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "publish failed", 500));
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
        <Panel>
          <h2 className="text-sm font-semibold">Governance</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-muted">Status</dt>
              <dd>{governance.status ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">Verity Record</dt>
              <dd>
                {governance.recordId ? (
                  <Link
                    className="font-mono text-xs underline"
                    href={`/audit/${governance.recordId}`}
                    data-testid="verity-record-link"
                  >
                    {governance.recordId.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Citations</dt>
              <dd>
                {(result?.citations ?? []).length === 0 ? (
                  "None"
                ) : (
                  <ul className="list-disc pl-4">
                    {result?.citations?.map((c, i) => (
                      <li key={i}>{c.title ?? c.source_id ?? "source"}{c.page ? ` p.${c.page}` : ""}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function ResearchForm({
  collections,
  busy,
  onSubmit,
}: {
  collections: Array<{ id: string; name: string }>;
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("grounded");
  const [selected, setSelected] = useState<string[]>([]);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ question, knowledge_mode: mode, collection_ids: selected });
  }
  return (
    <form className="space-y-3" onSubmit={submit}>
      <label className="field">
        Question
        <textarea required rows={4} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <label className="field">
        Knowledge mode
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="strict">strict</option>
          <option value="grounded">grounded</option>
          <option value="general">general</option>
        </select>
      </label>
      <fieldset className="field">
        <legend>Knowledge collections</legend>
        {collections.length === 0 ? <p className="text-sm text-muted">No readable collections.</p> : null}
        {collections.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
              }
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? "Executing…" : "Run research"}
      </button>
    </form>
  );
}

function DraftingForm({
  collections,
  busy,
  onSubmit,
}: {
  collections: Array<{ id: string; name: string }>;
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [documentType, setDocumentType] = useState("memo");
  const [mode, setMode] = useState("grounded");
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ instruction, document_type: documentType, knowledge_mode: mode, collection_ids: selected });
      }}
    >
      <label className="field">
        Instruction
        <textarea required rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <label className="field">
        Document type
        <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
          <option value="memo">memo</option>
          <option value="brief">brief</option>
          <option value="press_release">press release</option>
          <option value="public_advisory">public advisory</option>
          <option value="general">general</option>
        </select>
      </label>
      <label className="field">
        Knowledge mode
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="strict">strict</option>
          <option value="grounded">grounded</option>
          <option value="general">general</option>
        </select>
      </label>
      <fieldset className="field">
        <legend>Optional collections</legend>
        {collections.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
              }
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? "Executing…" : "Run drafting"}
      </button>
    </form>
  );
}

function SocialForm({
  collections,
  brands,
  busy,
  onSubmit,
}: {
  collections: Array<{ id: string; name: string }>;
  brands: Array<{ brand_id: string; display_name: string; active: boolean }>;
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const active = brands.filter((b) => b.active);
  const [brandId, setBrandId] = useState("");
  const [platform, setPlatform] = useState("facebook");
  useEffect(() => {
    if (!brandId && active[0]) {
      setBrandId(active[0].brand_id);
    }
  }, [active, brandId]);
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ brand_id: brandId, platform, topic: topic || undefined, collection_ids: selected });
      }}
    >
      <label className="field">
        Brand
        <select required value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">Select brand</option>
          {active.map((b) => (
            <option key={b.brand_id} value={b.brand_id}>
              {b.display_name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Platform
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="facebook">facebook</option>
        </select>
      </label>
      <label className="field">
        Topic (optional)
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>
      <fieldset className="field">
        <legend>Optional collections</legend>
        {collections.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
              }
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <button className="btn btn-primary" disabled={busy || !brandId} type="submit">
        {busy ? "Executing…" : "Generate draft"}
      </button>
    </form>
  );
}

function ResultPane({
  result,
  detail,
  skillId,
  unsealed,
  draftEdit,
  sealed,
  onEdit,
  canApprove,
  onDecide,
  onPublish,
}: {
  result: NovaExecuteResult | null;
  detail: NovaRunDetail | null;
  skillId: string;
  unsealed: boolean;
  draftEdit: string | null;
  sealed: string;
  onEdit: (value: string) => void;
  canApprove: boolean;
  onDecide: (allow: boolean) => Promise<void>;
  onPublish: (action: "publish_post" | "schedule_post", scheduledFor?: string) => Promise<void>;
}) {
  const [schedule, setSchedule] = useState("");
  const status = result?.status ?? detail?.execution.status;
  const artifact = draftEdit ?? sealed;
  if (!result && !detail) {
    return <EmptyState title="No result yet" body="Run a skill or open a previous execution." />;
  }
  return (
    <Panel>
      {status === "blocked" || (status === "failed" && skillId === "nova.research") ? (
        <div className="mb-3 border border-warn/40 bg-[var(--accent-soft)] px-3 py-2 text-sm" role="status">
          Insufficient approved evidence
        </div>
      ) : null}
      {result?.status === "blocked" ? (
        <p className="mb-3 text-sm font-medium text-warn">Insufficient approved evidence</p>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill label={status ?? "unknown"} />
        {unsealed ? <StatusPill label="Unsealed local edit" tone="warn" /> : null}
        {detail?.social_item ? <StatusPill label={connectorStateLabel(detail.social_item.status)} /> : null}
      </div>
      {skillId === "nova.drafting" || skillId === "nova.social.draft" ? (
        <label className="field">
          Artifact
          <textarea rows={10} value={artifact} onChange={(e) => onEdit(e.target.value)} />
        </label>
      ) : (
        <pre className="whitespace-pre-wrap border border-line bg-paper p-3 text-sm">{artifact || "No artifact."}</pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(artifact)}>
          Copy
        </button>
      </div>
      {detail?.social_item ? (
        <dl className="mt-4 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-muted">Pillar</dt>
            <dd>{detail.social_item.brand_id}</dd>
          </div>
          <div>
            <dt className="text-muted">Artifact hash</dt>
            <dd>
              <HashValue value={detail.social_item.artifact_hash} label="artifact hash" />
            </dd>
          </div>
          {detail.social_item.external_action_id ? (
            <div>
              <dt className="text-muted">external_action_id</dt>
              <dd className="font-mono text-xs">{detail.social_item.external_action_id}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {detail?.approval?.status === "pending" ? (
        <div className="mt-4 border border-line p-3">
          <h3 className="text-sm font-semibold">Pending approval</h3>
          <p className="mt-1 text-sm">{detail.execution.skill_id}</p>
          <p className="text-sm text-muted">Requester {detail.approval.requested_by}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm">{detail.social_item?.draft_text ?? artifact}</p>
          <p className="mt-2">
            <HashValue value={detail.approval.artifact_hash} label="approval artifact hash" />
          </p>
          <p className="mt-2 text-sm text-muted">A different authorized user must decide. Self-approval is denied.</p>
          {canApprove ? (
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn btn-primary" onClick={() => void onDecide(true)}>
                Approve
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void onDecide(false)}>
                Reject
              </button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">You do not have approvals.decide.</p>
          )}
        </div>
      ) : null}
      {detail?.approval?.status === "approved" && detail.social_item && !unsealed ? (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void onPublish("publish_post")}>
              Publish Now
            </button>
          </div>
          <label className="field max-w-sm">
            Schedule (timezone-aware)
            <input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!schedule}
            onClick={() => void onPublish("schedule_post", new Date(schedule).toISOString())}
          >
            Schedule
          </button>
        </div>
      ) : null}
    </Panel>
  );
}
