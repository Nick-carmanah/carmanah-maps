// Harness only (scripts/add-maps-page.mjs injects it into the harness copy of
// maps/index.html and maps/offline.html): drives the maps page the way a
// person would, from instructions the harness command leaves in localStorage
// ("harness.drive"), and writes what it saw to
// Library/NoCloud/maps/_harness/results/<step>.json.
//   {"step":"download","fire":"C40983","center":[-121.7,51.19]}  Offline maps → the fire → Check size → Download
//   {"step":"resume"}                                             just open the page (downloads resume by themselves)
//   {"step":"offline","center":[…],"zooms":[9.5,12.5,14.5]}      fly over the fire and report what was drawn
;(function () {
  var raw = localStorage.getItem('harness.drive')
  if (!raw) return
  localStorage.removeItem('harness.drive')
  var cmd = JSON.parse(raw)
  var violations = []
  document.addEventListener('securitypolicyviolation', function (e) {
    violations.push(e.blockedURI + ' (' + e.violatedDirective + ')')
  })
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  var until = async function (fn, what, ms) {
    var end = Date.now() + (ms || 60000)
    for (;;) {
      try { var v = fn(); if (v) return v } catch (e) {}
      if (Date.now() > end) throw new Error('timed out: ' + what)
      await sleep(300)
    }
  }
  var button = function (text) {
    return Array.prototype.find.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim().indexOf(text) === 0 })
  }
  var save = async function (name, data) {
    var fs = window.Capacitor.Plugins.Filesystem
    await fs.writeFile({ path: 'maps/_harness/results/' + name + '.json', directory: 'LIBRARY_NO_CLOUD', data: JSON.stringify(data, null, 2), encoding: 'utf8', recursive: true })
  }
  var run = async function () {
    var out = { step: cmd.step, at: new Date().toISOString() }
    try {
      await until(function () { return window.__map && window.__map.isStyleLoaded() }, 'map', 60000)
      var map = window.__map
      // My Maps opens first: go to the base map (as a person would).
      var openBase = function () {
        var b = document.querySelector('button[aria-label="Open the base map"]')
        if (b) b.click()
      }
      if (cmd.step === 'download') {
        openBase()
        await sleep(800)
        map.jumpTo({ center: cmd.center, zoom: 9 })
        await sleep(2500)
        button('⬇ Offline maps').click()
        var select = await until(function () { return document.querySelector('select[aria-label=Fire]') }, 'fire list (live fires)', 60000)
        await until(function () { return Array.prototype.some.call(select.options, function (o) { return o.value === cmd.fire }) }, 'fire ' + cmd.fire, 30000)
        var set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        set.call(select, cmd.fire)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(300)
        button('Check size').click()
        out.size = (await until(function () { return document.querySelector('.offline-size') }, 'size', 60000)).textContent
        out.confirm = document.querySelector('.offline-confirm').innerText
        button('Download').click()
        await until(function () { return document.querySelector('.pack-list.saved .pack-row') }, 'download row', 30000)
        out.started = document.querySelector('.pack-list.saved .pack-meta').textContent
      } else if (cmd.step === 'resume') {
        await sleep(1500)
        var entry = document.querySelector('.base-offline') || button('Saving') || button('⬇ Offline maps')
        entry.click()
        await sleep(1500)
        out.rows = Array.prototype.map.call(document.querySelectorAll('.pack-list.saved .pack-row'), function (r) { return r.innerText })
      } else if (cmd.step === 'offline') {
        openBase()
        await sleep(800)
        out.views = []
        for (var i = 0; i < cmd.zooms.length; i++) {
          map.jumpTo({ center: cmd.center, zoom: cmd.zooms[i] })
          await until(function () { return map.loaded() && map.areTilesLoaded() }, 'tiles at z' + cmd.zooms[i], 60000)
          await sleep(1500)
          var feats = map.queryRenderedFeatures()
          var by = {}
          feats.forEach(function (f) { by[f.source] = (by[f.source] || 0) + 1 })
          out.views.push({ zoom: map.getZoom(), features: feats.length, bySource: by })
          await save('offline-view-' + i, { ready: true, zoom: cmd.zooms[i] })
          await sleep(cmd.pauseMs || 4000) // the Mac takes a screenshot now
        }
      }
    } catch (e) {
      out.error = String(e && e.message || e)
    }
    out.cspViolations = violations
    out.offlineSheetText = document.querySelector('.offline-sheet') ? document.querySelector('.offline-sheet').innerText.slice(0, 600) : null
    await save(cmd.step, out)
  }
  addEventListener('load', function () { run() })
})()
