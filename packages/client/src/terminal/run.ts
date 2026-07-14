import type { Api } from "../api/client"
import type { Tab } from "@coolie/protocol"

/** GUI Run 按钮的单一行为：请求服务端单例 run tab，并立即选中返回行。 */
export const openRunTab = async (
  api: Pick<Api, "req">,
  workspaceId: string,
  select: (workspaceId: string, tabId: string) => void,
): Promise<Tab> => {
  const tab = await api.req("POST", `/workspaces/${workspaceId}/tabs`, { kind: "run" }) as Tab
  select(workspaceId, tab.id)
  return tab
}
