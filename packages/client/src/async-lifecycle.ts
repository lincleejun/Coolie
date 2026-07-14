export interface AsyncLifecycleOwner {
  readonly isCurrent: () => boolean
  readonly own: (stop: () => void) => void
}

export const createAsyncLifecycle = (
  bootstrap: (owner: AsyncLifecycleOwner) => void | Promise<void>,
  onError: (error: unknown) => void = () => {},
): { readonly start: () => () => void } => {
  let generation = 0
  return {
    start: () => {
      const mine = ++generation
      let active = true
      const stops = new Set<() => void>()
      const stopOnce = (stop: () => void): (() => void) => {
        let stopped = false
        return () => {
          if (stopped) return
          stopped = true
          stop()
        }
      }
      const owner: AsyncLifecycleOwner = {
        isCurrent: () => active && generation === mine,
        own: (stop) => {
          const owned = stopOnce(stop)
          if (owner.isCurrent()) stops.add(owned)
          else owned()
        },
      }
      void Promise.resolve(bootstrap(owner)).catch((error) => {
        if (owner.isCurrent()) onError(error)
      })
      return () => {
        if (!active) return
        active = false
        for (const stop of stops) stop()
        stops.clear()
      }
    },
  }
}
