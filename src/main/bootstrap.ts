// Import order is intentional: Electron identity and userData must be set
// before any module in index.ts evaluates settings, partitions or token stores.
import './configureAppIdentity'
import './index'
