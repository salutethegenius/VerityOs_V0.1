"use client";

import { listUsers } from "@/lib/api/command";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";

export default function UsersPage() {
  const list = useAsync(() => listUsers(), []);
  return (
    <div>
      <PageHeader
        title="Users"
        description="Organization members. This list is read-only in V0.1."
      />
      <p className="mb-4 text-sm text-muted">User provisioning is operator-assisted in V0.1. This page is not missing controls because of an error.</p>
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.users.length === 0 ? (
        <EmptyState title="No users" body="No members are visible for this organization." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.users.map((u) => (
              <tr key={u.id}>
                <td>{u.display_name}</td>
                <td>{u.email}</td>
                <td>{u.status}</td>
                <td>{u.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
