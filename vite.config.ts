import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Relative base so the build works from a GitHub Pages project URL (/<repo>/).
export default defineConfig({
  base: './',
  plugins: [react()],
})
