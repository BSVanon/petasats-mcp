export function makeThrottledLog(write: (message: string) => void, { windowMs = 600_000, maxShapes = 256, now = Date.now }: { windowMs?: number; maxShapes?: number; now?: () => number } = {}): (message: string) => void {
  const shapes = new Map<string, { lastPrinted: number; suppressed: number }>()
  const neverSuppress = /CRITICAL|FAILED|failed|WARN|warn|error|Error|refused|ATTENTION|cannot|⚠|🚨|STOP/
  const minutes = Math.ceil(windowMs / 60_000)
  // Numbers vary between repeats of one line; identifiers (hex runs of 6+ with a letter) name a swap or tx and are kept,
  // so only repeats about the same swap are counted together.
  const shapeOf = (message: string): string => message.replace(/[0-9a-fA-F]{6,}|\d+/g, (run) => /^\d+$/.test(run) ? '#' : run)

  return (message: string): void => {
    if (neverSuppress.test(message)) {
      write(message)
      return
    }
    const shape = shapeOf(message)
    const at = now()
    const entry = shapes.get(shape)
    if (entry && at - entry.lastPrinted < windowMs) {
      entry.suppressed++
      return
    }
    if (!entry && shapes.size >= maxShapes) {
      let oldestShape: string | undefined
      let oldestPrinted = Infinity
      for (const [candidate, value] of shapes) {
        if (value.lastPrinted < oldestPrinted) {
          oldestShape = candidate
          oldestPrinted = value.lastPrinted
        }
      }
      if (oldestShape !== undefined) shapes.delete(oldestShape)
    }
    write(entry?.suppressed ? `${message} (${entry.suppressed} similar lines in the last ${minutes} min)` : message)
    shapes.set(shape, { lastPrinted: at, suppressed: 0 })
  }
}
