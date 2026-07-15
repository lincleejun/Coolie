import type { DiffSection } from "../stores/types"
import { DiffView } from "./DiffView"
import { injectComment } from "./comment"

export const CenterDiff = ({ wsId, section, path }: {
  wsId: string
  section: DiffSection
  path: string
}) => (
  <div className="center-diff">
    <DiffView
      wsId={wsId}
      section={section}
      path={path}
      onComment={(selection) => { void injectComment(wsId, selection) }}
    />
  </div>
)
