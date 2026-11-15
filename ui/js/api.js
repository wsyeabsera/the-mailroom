// fetch wrapper for /admin/*. A 401 signed_out on any call sends the user to the sign-in page.
export class ApiError extends Error {
  constructor(status, data) {
    super((data && (data.message || data.error)) || `HTTP ${status}`);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: "network", message: "Could not reach the mailroom." });
  }
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { /* not JSON */ }
  }
  if (res.status === 401 && data && data.error === "signed_out") {
    location.replace("/login.html");
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// key id -> label, for rows that only carry key_id
export async function keyLabels() {
  const keys = await api("/admin/keys");
  return new Map(keys.map((k) => [k.id, k.label]));
}
