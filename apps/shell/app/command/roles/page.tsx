"use client";

import { listRoles } from "@/lib/api/command";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";

export default function RolesPage() {
  const list = useAsync(() => listRoles(), []);
  return (
    <div>
      <PageHeader title="Roles" description="Role names and permissions as stored in Core. This view is read-only in V0.1." />
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.roles.length === 0 ? (
        <EmptyState title="No roles" body="This organization has no roles." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Permissions</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.roles.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.description}</td>
                <td className="font-mono text-xs">{r.permissions.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
