// Puts the embedded maps build (../dist-embedded, from `npm run build:embedded`
// at the repo root) into this app at maps/, and Capacitor's core script at
// /capacitor.js, the way the crew app serves both. Run by `npm run sync:maps`.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(HERE, '..', 'dist-embedded')
if (!existsSync(join(BUILD, 'precache-manifest.json'))) {
  throw new Error('No embedded build: run `npm run build:embedded` at the repo root first')
}
rmSync(join(HERE, 'dist', 'maps'), { recursive: true, force: true })
cpSync(BUILD, join(HERE, 'dist', 'maps'), { recursive: true })
cpSync(join(HERE, 'node_modules/@capacitor/core/dist/capacitor.js'), join(HERE, 'dist', 'capacitor.js'))

// Harness only: report the page's load failures and uncaught errors to the
// Xcode console (Capacitor forwards console.error), and a status line after
// 4 s. Added before /capacitor.js; the page is otherwise the build unchanged.
const REPORTER = `<script>(function(){function r(k,m){console.error('[maps page] '+k+': '+m)}
addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href))r('load failed',t.src||t.href);else r('error',e.message+' @'+e.filename+':'+e.lineno)},true);
addEventListener('unhandledrejection',function(e){r('rejection',String(e.reason&&e.reason.stack||e.reason))});
setTimeout(function(){var c=window.Capacitor;r('status','rendered='+(document.getElementById('root').childElementCount>0)+' native='+!!(c&&c.isNativePlatform&&c.isNativePlatform())+' Filesystem='+!!(c&&c.isPluginAvailable&&c.isPluginAvailable('Filesystem'))+' Share='+!!(c&&c.isPluginAvailable&&c.isPluginAvailable('Share')));var t=document.querySelector('.topbar'),b=t&&t.getBoundingClientRect();r('layout','scrollY='+scrollY+' innerHeight='+innerHeight+' docHeight='+document.documentElement.scrollHeight+' topbar y='+(b&&Math.round(b.y))+' h='+(b&&Math.round(b.height))+' paddingTop='+(t&&getComputedStyle(t).paddingTop))},4000)})();</script>`
const page = join(HERE, 'dist', 'maps', 'index.html')
const html = readFileSync(page, 'utf8')
if (!html.includes('<script src="/capacitor.js"></script>')) throw new Error('maps/index.html has no /capacitor.js script')
writeFileSync(page, html.replace('<script src="/capacitor.js"></script>', REPORTER + '<script src="/capacitor.js"></script>'))
console.log('maps/ and capacitor.js added to dist/')
