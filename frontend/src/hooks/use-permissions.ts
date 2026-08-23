// Frontend mirror of the backend's require_role() gates (see
// backend/server.py Role/require_role). The API is the real enforcement —
// this hook exists so the UI doesn't dangle a button a crew user can tap
// and only then find out (via a 403) that they weren't allowed to.
import { useAuth } from "@/src/context/AuthContext";

export function usePermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return {
    role,
    // Most create/edit/delete actions in this app require foreman or admin.
    canEdit: role === "foreman" || role === "admin",
    // A few destructive/ownership actions (delete equipment, site settings,
    // user management) are admin-only.
    canAdmin: role === "admin",
  };
}
