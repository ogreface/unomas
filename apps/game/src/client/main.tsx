import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { installAudioUnlock } from './lib/sound.js'
import './styles.css'

// From the very first tap — usually *Join* or *Start*, well before the first sound is due.
installAudioUnlock()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
