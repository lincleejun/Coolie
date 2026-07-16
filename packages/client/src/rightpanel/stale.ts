/**
 * Guard late async results after a task/workspace switch.
 * Used by RightPanel files fetch (and mirrored by DiffView cancelled flag).
 */
export const shouldApplyAsyncResult = (
  requestedWsId: string,
  currentWsId: string,
  cancelled: boolean,
): boolean => !cancelled && requestedWsId === currentWsId
