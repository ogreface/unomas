import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

/**
 * One Vite build, two outputs: the React SPA (`dist/client`) and the Worker bundle. The Cloudflare
 * plugin reads `wrangler.jsonc`, runs the Worker in workerd during `vite dev` (so the Durable
 * Object behaves exactly as it will in production), and wires the `ASSETS` binding to the built SPA.
 */
export default defineConfig({
  plugins: [react(), cloudflare()],
})
