/**
 * Side-effect type import so the renderer project (tsconfig.web.json includes
 * this file) picks up the `declare global { interface Window { uld: UldApi } }`
 * augmentation from src/shared/ipc.ts.
 */
import '@shared/ipc'
