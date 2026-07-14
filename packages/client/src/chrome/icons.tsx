import type { ReactNode, SVGProps } from "react"

/** Local feather-style icon set, ported pixel-for-pixel from the approved Conductor
 *  mockup (design/Coolie macOS Redesign.html). Kept dependency-free (no icon lib) so
 *  the chrome matches Conductor 1:1 and stays offline-safe. 16×16 viewBox, currentColor. */
export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

const stroke =
  (body: ReactNode, sw = 1.4, viewBox = "0 0 16 16") =>
  ({ size = 16, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {body}
    </svg>
  )

const filled =
  (body: ReactNode, viewBox = "0 0 16 16") =>
  ({ size = 16, ...rest }: IconProps) => (
    <svg width={size} height={size} viewBox={viewBox} fill="currentColor" aria-hidden="true" {...rest}>
      {body}
    </svg>
  )

export const PanelLeftIcon = stroke(<><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 4v12" /></>, 1.5, "0 0 20 20")
export const PanelRightIcon = stroke(<><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M13 4v12" /></>, 1.5, "0 0 20 20")
export const ChevronLeftIcon = stroke(<path d="M12 5l-5 5 5 5" />, 1.6, "0 0 20 20")
export const ChevronRightIcon = stroke(<path d="M8 5l5 5-5 5" />, 1.6, "0 0 20 20")
export const ChevronDownIcon = stroke(<path d="M4 6l4 4 4-4" />, 1.6)
export const CaretRightIcon = stroke(<path d="M5.5 3.5 10 8l-4.5 4.5" />, 1.6)
export const PlusIcon = stroke(<path d="M8 3.5v9M3.5 8h9" />, 1.5)
export const FilterIcon = stroke(<path d="M2.5 4h11M4.5 8h7M6.5 12h3" />)
export const FolderPlusIcon = stroke(<><path d="M2.2 4.4a1 1 0 0 1 1-1h3l1.4 1.5h4.2a1 1 0 0 1 1 1v5.7a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z" /><path d="M8 7v3.2M6.4 8.6h3.2" /></>)
export const FolderIcon = stroke(<path d="M2 4.6a1 1 0 0 1 1-1h3.1l1.3 1.4H13a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />, 1.3)
export const GitBranchIcon = stroke(<><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="6" r="1.5" /><path d="M4 5v6M4 10.5C4 8 8 8.5 10.5 6.8" /></>)
export const HelpIcon = stroke(<><circle cx="8" cy="8" r="6" /><path d="M6.3 6.2a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.7.6-.7 1.1M8 11.2v.1" /></>)
export const SettingsIcon = stroke(<><circle cx="8" cy="8" r="2.1" /><path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7 3.5 3.5" /></>, 1.3)
export const SearchIcon = stroke(<><circle cx="7" cy="7" r="4.3" /><path d="M10.2 10.2 13.5 13.5" /></>)
export const ListIcon = stroke(<path d="M3 4h2M3 8h2M3 12h2M7 4h6M7 8h6M7 12h6" />)
export const CloseIcon = stroke(<path d="M4 4l8 8M12 4l-8 8" />, 1.5)
export const SendIcon = stroke(<path d="M10 15.5V5M5.5 9.5 10 5l4.5 4.5" />, 1.7, "0 0 20 20")
export const AttachIcon = stroke(<path d="M10 5v10M5 10h10" />, 1.5, "0 0 20 20")
export const CopyIcon = stroke(<><rect x="5" y="5" width="8" height="9" rx="1.4" /><path d="M3 11V3a1 1 0 0 1 1-1h6" /></>)
export const RetryIcon = stroke(<path d="M13 7a5 5 0 1 0-.5 3M13 3.5V7h-3.5" />)
export const StopIcon = filled(<rect x="4" y="4" width="8" height="8" rx="1.6" />)
export const HistoryIcon = stroke(<><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.6" /></>)
export const BookIcon = stroke(<><path d="M8 3.4C6.7 2.6 4.8 2.4 3 2.6v9c1.8-.2 3.7 0 5 .8 1.3-.8 3.2-1 5-.8v-9c-1.8-.2-3.7 0-5 .8z" /><path d="M8 3.4v9.2" /></>, 1.3)
export const SparkleIcon = filled(<path d="M8 1l1.2 4.1L13.5 4l-2.9 3.3L15 8l-4.4.7 2.9 3.3-4.3-1.1L8 15l-1.2-4.1L2.5 12l2.9-3.3L1 8l4.4-.7L2.5 4l4.3 1.1z" />)
export const EffortIcon = filled(<><rect x="2" y="9" width="2.6" height="5" rx="1" /><rect x="6.7" y="6" width="2.6" height="8" rx="1" /><rect x="11.4" y="3" width="2.6" height="11" rx="1" opacity=".4" /></>)
