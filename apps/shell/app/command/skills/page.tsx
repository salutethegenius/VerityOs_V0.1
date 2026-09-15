"use client";

import { listCommandSkills } from "@/lib/api/command";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";

export default function SkillsPage() {
  const list = useAsync(() => listCommandSkills(), []);
  return (
    <div>
      <PageHeader title="Skills" description="Governed skill policies. This view is read-only in V0.1." />
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.skills.length === 0 ? (
        <EmptyState title="No skills" body="No skill policies are registered." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
              <th>Version</th>
              <th>Risk</th>
              <th>Knowledge mode</th>
              <th>Permissions</th>
              <th>Approval</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.skills.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="font-mono text-xs">{s.id}</td>
                <td>{s.version}</td>
                <td>{s.risk_tier}</td>
                <td>{s.knowledge_mode ?? "—"}</td>
                <td className="font-mono text-xs">{s.required_permissions?.join(", ") || "—"}</td>
                <td>{s.approval_policy ?? (s.approval ? "required" : "none")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
