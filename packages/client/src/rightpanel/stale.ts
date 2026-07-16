/**
 * Guard late async results after a task/workspace switch.
 * Compare the request's workspace against the live selected workspace
 * so a completed fetch cannot paint into a panel that has already moved on.
 */
export const shouldApplyAsyncResult = (
  requestedWsId: string,
  currentWsId: string | null | undefined,
  cancelled: boolean,
): boolean => !cancelled && currentWsId != null && requestedWsId === currentWsId

/** @deprecated Prefer shouldApplyAsyncResult — kept for call-site clarity aliases. */
export const shouldApplyWsResult = (
  cancelled: boolean,
  requestedWsId: string,
  activeWsId: string | null | undefined,
): boolean => shouldApplyAsyncResult(requestedWsId, activeWsId, cancelled)
