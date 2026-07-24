import '@testing-library/jest-dom/vitest'

// jsdom has no ResizeObserver, which CanvasEditorPage uses to size the Stage
// to the workspace. A no-op stub is enough — the tests mock CanvasStage and
// don't assert on the measured viewport.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
