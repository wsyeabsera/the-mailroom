/** What cancelling a job does, by its current state. `stop` means the daemon must be told to kill it. */
export function cancelAction(state: string): "drop" | "stop" | "conflict" {
  if (state === "queued" || state === "waiting_approval") return "drop";
  if (state === "running") return "stop";
  return "conflict";
}
