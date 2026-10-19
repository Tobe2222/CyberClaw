try { require('fs').appendFileSync(require('path').join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] pixel-arena.js TOP\n`); } catch {}
/* ============================================================ PixelArena — Shared 2D arena with Companions Companion = an agent's visual… */

const _path = require('path');
const _fs = require('fs');
try { _fs.appendFileSync(_path.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] pixel-arena.js requires OK\n`); } catch {}

class PixelArena {
  constructor(containerId) {

    this.container = typeof containerId === 'string'
      ? document.getElementById(containerId)
      : containerId;
    if (!this.container) return;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pixel-arena-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    // Main companion (pixel sprite, big)
    // v3.1.5: support multiple companions. this.companions is the array;
    // this.companion is a convenience ref to the first one for back-compat.
    this.companions = [];
    this.companion = null;

    this.animId = null;
    this.lastTime = 0;

    // Background image + horizon
    this.bgImage = null;
    this.horizonLine = 0.7; // v3.1.17: fraction of canvas height — companions stay below this. Was 0.5; Tobe: 'the background allows them to go a bit too high up.' 0.7 keeps companions in the lower 30% of the arena.

    // Ground (fallback when no bg image)
    this.groundColor = '#1a2a1a';
    this.grassPatches = [];

    this.onSelect = null; // callback(agentId) when entity clicked

    // Treats system (food — gets eaten)
    // Use global treat store so treats survive arena rebuilds
    if (!window._arenaTreats) window._arenaTreats = [];
    this.treats = window._arenaTreats;
    this.companionEmoji = null; // { emoji, timer }

    // Toys system (interactive — bounce physics)
    if (!window._arenaToys) window._arenaToys = [];
    this.toys = window._arenaToys;
    if (!window._arenaRockets) window._arenaRockets = [];
    this.rockets = window._arenaRockets;
    this._draggedToy = null; // currently dragged toy

    // Speech bubble
    this.bubbleEl = null;
    this.bubbleTimer = null;

    this._resize();
    this._generateGrass();
    this._initResize();
    this._initClick();
    this._initToyDrag();
    this._initCompanionDrag(); // v3.1.17: drag-and-drop companions for posing pictures
    this._animate();
  }

  _initClick() {
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (this.width / rect.width);
      const my = (e.clientY - rect.top) * (this.height / rect.height);

      // Check companion
      if (this.companion) {
        const c = this.companion;
        const dw = (c.data.frameSize[0] || 32) * c.scale;
        const dh = (c.data.frameSize[1] || 32) * c.scale;
        if (mx >= c.x && mx <= c.x + dw && my >= c.y && my <= c.y + dh) {
          if (this.onSelect) this.onSelect(c.id);
          return;
        }
      }
    });
    this.canvas.style.cursor = 'pointer';
  }

  _resize() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 400;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
  }

  resize() { this._resize(); }

  _initResize() {
    this.resizeObs = new ResizeObserver(() => {
      this._resize();
      this._generateGrass();
    });
    this.resizeObs.observe(this.container);
  }

  _generateGrass() {
    this.grassPatches = [];
    const count = Math.floor((this.width * this.height) / 800);
    for (let i = 0; i < count; i++) {
      this.grassPatches.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        size: 2 + Math.random() * 4,
        shade: Math.random() * 0.3
      });
    }
  }

  // ── BACKGROUND ──────────────────────────────────────────────

  setBackground(imagePath) {
    if (!imagePath) { this.bgImage = null; return; }
    const img = new Image();
    img.onload = () => { this.bgImage = img; };
    img.onerror = () => { this.bgImage = null; };
    img.src = `file://${imagePath}`;
  }

  // ── COMPANION (main, pixel sprite) ──────────────────────────

  // Helper to build a companion object (used by setCompanion and addCompanion).
  async _buildCompanion(agentId, pixelCompanionId, name, scale) {
    const catalog = window.loadPixelCatalog ? window.loadPixelCatalog() : { companions: [] };
    const compData = catalog.companions.find(c => c.id === pixelCompanionId);
    if (!compData) {
      console.warn('[PixelArena] No catalog entry for', pixelCompanionId);
      return null;
    }

    // Load sprite images
    const assetsDir = window._assetsDir || _path.join(__dirname, '..', 'assets');
    const basePath = _path.join(assetsDir, 'companions', compData.folder);
    const images = {};

    for (const [animName, animData] of Object.entries(compData.animations)) {
      const imgPath = _path.join(basePath, animData.file);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => resolve(); // don't crash on missing anims
        img.src = `file://${imgPath}`;
      });
      images[animName] = { img, frames: animData.frames, cols: animData.cols || animData.frames, rowMap: animData.rowMap || null };
    }

    // Per-companion chase personality so they don't all converge on the same toy at the same speed.
    const chasePersonality = {
      speedMult: 0.75 + Math.random() * 0.55,
      reactRadius: 60 + Math.random() * 120,
      reactionDelay: Math.random() * 800,
    };

    return {
      id: agentId,
      name: name || 'Companion',
      pixelCompanionId,
      data: compData,
      images,
      x: this.width / 2,
      y: this.height * Math.max(this.horizonLine + 0.1, 0.5),
      vx: 0,
      vy: 0,
      direction: 0,
      animation: 'idle',
      frame: 0,
      frameTimer: 0,
      frameSpeed: 150,
      state: 'idle',
      stateTimer: 3000 + Math.random() * 3000,
      scale: (typeof scale === 'number' && scale >= 1 && scale <= 8) ? scale : 5,
      sleepState: 'awake', // v3.1.4: 'awake' | 'sleeping' — set by app.js toggle
      // v3.1.17: chase personality + collision body. See the
      // chasePersonality block above for the meaning of each axis.
      chasePersonality,
      // Cylindrical collision body for companion↔companion repulsion.
      bodyRadius: 0,
    };
  }

  // Public: clear all companions and add a single one (legacy API).
  async setCompanion(agentId, pixelCompanionId, name, scale) {
    const c = await this._buildCompanion(agentId, pixelCompanionId, name, scale);
    if (!c) return;
    this.companions = [c];
    this.companion = c;
  }

  // Public: add a companion alongside existing ones. Positioned by
  // index in the companions array, evenly spread horizontally.
  async addCompanion(agentId, pixelCompanionId, name, scale) {
    if (this.companions.find(c => c.id === agentId)) return;
    const c = await this._buildCompanion(agentId, pixelCompanionId, name, scale);
    if (!c) return;
    this.companions.push(c);
    this._repositionCompanions();
    if (!this.companion) this.companion = c;
  }

  // Remove a specific companion by agentId
  removeCompanion(agentId) {
    this.companions = this.companions.filter(c => c.id !== agentId);
    if (this.companion && this.companion.id === agentId) {
      this.companion = this.companions[0] || null;
    }
    this._repositionCompanions();
  }

  // Spread existing companions evenly across the arena width.
  _repositionCompanions() {
    const n = this.companions.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      this.companions[i].x = this.width * (i + 1) / (n + 1);
      this.companions[i].y = this.height * Math.max(this.horizonLine + 0.1, 0.5);
    }
  }

  // v3.1.5: Replace the sprite of an existing companion (e.g. when the
  // user picks a new sprite for a companion in the picker). Keeps the
  // companion in the same slot in the layout.
  async swapCompanionSprite(agentId, pixelCompanionId, name, scale) {
    const idx = this.companions.findIndex(c => c.id === agentId);
    if (idx < 0) {
      // Not in the arena — fall back to setCompanion
      return this.setCompanion(agentId, pixelCompanionId, name, scale);
    }
    const newC = await this._buildCompanion(agentId, pixelCompanionId, name, scale);
    if (!newC) return;
    // Preserve position and sleep state from the existing companion
    newC.x = this.companions[idx].x;
    newC.y = this.companions[idx].y;
    newC.sleepState = this.companions[idx].sleepState;
    this.companions[idx] = newC;
    if (this.companion && this.companion.id === agentId) this.companion = newC;
  }

  // ── SPEECH BUBBLE ────────────────────────────────────────────

  showBubble(text, durationMs, speakerId) {
    if (this.bubbleEl) {
      this.bubbleEl.remove();
      this.bubbleEl = null;
    }
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    // v3.6.10: also log the speech in the casual chat. Active quest doesn't
    // change; the desktop marks it as ambient and the phone skips notifications.
    // v3.6.10: also drop the line into the chat. arena.js is in the renderer,
    // so addChatMsg (renderer-local) handles the desktop chat list; the existing
    // sync-broadcast-chat IPC keeps mobile in sync. mainWindow.webContents.send
    // doesn't help because broadcastChatMessage only ships to WebSocket clients.
    try {
      if (!text || text.length < 3) {}
      else {
        const src = (this._chatBubbleSrc || '').split('|');
        const lastId = src[0] || '', lastPrefix = src[1] || '';
        const id = String(Date.now());
        const same = lastId && Date.now() - Number(lastId) < 5000 && text.startsWith(lastPrefix);
        if (!same) {
          let nm = ''; try { const c = (this.companions || []).find(x => x.id === speakerId); if (c) nm = c.name || ''; } catch (_) {}
          // desktop chat list. addChatMsg uses the active chat bucket by default;
          // passing '__no_quest__' here would mismatch the active quest and trip
          // its chat-context guard (line ~3518 in app.js: returns null if the
          // effective bucket and active bucket differ). The user sees the bubble
          // in whichever chat they happen to be in, which is the natural place.
          try {
            if (typeof window.addChatMsg === 'function') {
              // Resolve the speaker's display name: prefer the desktop's agents
              // map (always populated, has the human-readable name); fall back
              // to the arena companion list; then the rocket's riderId; else
              // just 'Companion'.
              let visibleNm = '';
              try { if (speakerId && window.agents && window.agents[speakerId] && window.agents[speakerId].name) visibleNm = window.agents[speakerId].name; } catch (_) {}
              if (!visibleNm) try { const c = (this.companions || []).find(x => x.id === speakerId); if (c && c.name) visibleNm = c.name; } catch (_) {}
              if (!visibleNm) try { const r = (this.rockets || []).find(x => x.riderId === speakerId); if (r && r.riderName) visibleNm = r.riderName; } catch (_) {}
              if (!visibleNm) visibleNm = nm || 'Companion';
              const id = window.addChatMsg('agent', text, visibleNm, null, null);
              try { console.log('[Bubble→Chat]', text, '->', id, 'name=' + visibleNm); } catch (_) {}
            } else { console.warn('[Bubble→Chat] addChatMsg missing'); }
          } catch (e) { try { console.error('[Bubble→Chat] addChatMsg failed:', e && e.message); } catch (_) {} }
          // mobile parity (existing IPC; main treats forceNoQuest as ambient)
          try { if (window.ipcRenderer && window.ipcRenderer.send && speakerId) window.ipcRenderer.send('sync-broadcast-chat', { agentId: speakerId, agentName: nm, text: text, isUser: false, forceNoQuest: true, activeQuestId: null, activeQuestName: null, attachments: null }); } catch (_) {}
          this._chatBubbleSrc = id + '|' + text.slice(0, 20);
        }
      }
    } catch (_) {}

    const bubble = document.createElement('div');
    bubble.className = 'arena-speech-bubble';
    bubble.textContent = text;
    // Use the canvas parent — don't change container positioning
    const parent = this.canvas.parentElement || this.container;
    parent.appendChild(bubble);
    this.bubbleEl = bubble;

    // Position above companion
    this._updateBubblePosition();

    const dur = durationMs || 10000;
    this.bubbleTimer = setTimeout(() => {
      if (bubble.parentNode) {
        bubble.style.opacity = '0';
        bubble.style.transition = 'opacity 0.8s ease-out';
        setTimeout(() => { if (bubble.parentNode) bubble.remove(); }, 800);
      }
      this.bubbleEl = null;
      this.bubbleTimer = null;
    }, dur);
  }

  _updateBubblePosition() {
    if (!this.bubbleEl || !this.companion) return;
    const comp = this.companion;
    const rect = this.canvas.getBoundingClientRect();
    const parentRect = (this.canvas.parentElement || this.container).getBoundingClientRect();
    const scale = rect.width / this.width;
    const fw = (comp.data.frameSize[0] || 32) * comp.scale;
    // Position relative to parent, accounting for canvas offset within parent
    const offsetX = rect.left - parentRect.left;
    const offsetY = rect.top - parentRect.top;
    const bx = offsetX + (comp.x + fw / 2) * scale - 40;
    const by = offsetY + (comp.y) * scale - 50;
    this.bubbleEl.style.left = Math.max(5, Math.min(bx, parentRect.width - 180)) + 'px';
    this.bubbleEl.style.top = Math.max(5, by) + 'px';
  }

  // ── TREATS & TOYS ─────────────────────────────────────────────

  static TOY_TYPES = ['ball', 'tennis-ball'];

  dropTreat(canvasX, canvasY, treatType, emoji) {
    if (treatType === 'rocket') { this._spawnRocket(canvasX, canvasY); return; }
    // Route toys to the physics system
    if (PixelArena.TOY_TYPES.includes(treatType)) {
      var H = this.height;
      var horizonY = H * this.horizonLine; // pixels from top
      var groundBottom = H - 10;
      var dropY = canvasY - 16;
      var groundRange = groundBottom - horizonY;

      // Calculate landing position based on where the ball is dropped
      // Higher drop (smaller y) → lands closer to horizon (further away in perspective)
      // Lower drop (larger y) → lands closer to bottom (nearer in perspective)
      var landingY, shouldFall;
      var minGround = horizonY + 20; // always land well below horizon
      if (dropY < horizonY) {
        // Dropped in the sky
        // skyRatio: 0 = top of screen, 1 = at horizon line
        var skyRatio = dropY / Math.max(1, horizonY);
        // skyRatio 0 (very top) → land just below horizon
        // skyRatio 1 (at horizon) → land near bottom of ground
        landingY = minGround + (groundBottom - minGround) * skyRatio * 0.9;
        shouldFall = true;
      } else {
        // Dropped on or below the ground — no falling needed
        landingY = Math.max(dropY, minGround);
        shouldFall = false;
      }

      window._arenaToys.push({
        x: canvasX - 16, y: dropY,
        vx: 0, vy: 0,
        type: treatType,
        emoji: emoji || '⚽',
        radius: treatType === 'tennis-ball' ? 8 : 16, // tennis ball is smaller
        age: 0,
        bouncePhase: 0,
        groundY: landingY,
        airborne: shouldFall,
        arcMode: false, // not a companion kick arc
        lastTouched: performance.now(),
      });
      this.toys = window._arenaToys;
      return;
    }
    // Food treat — gets eaten
    window._arenaTreats.push({
      x: canvasX - 14,
      y: canvasY - 14,
      type: treatType,
      emoji: emoji || '🍖',
      scale: 1,
      age: 0,
      bouncePhase: 0,
      graceTimer: 2000
    });
    this.treats = window._arenaTreats;
  }

  _initToyDrag() {
    const arena = this;
    let dragging = null;
    let dragOffX = 0, dragOffY = 0;
    let lastMX = 0, lastMY = 0;
    let lastDragTime = 0;

    function canvasCoord(e) {
      const rect = arena.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (arena.width / rect.width),
        y: (e.clientY - rect.top) * (arena.height / rect.height)
      };
    }

    function findToy(mx, my) {
      for (let i = arena.toys.length - 1; i >= 0; i--) {
        const t = arena.toys[i];
        const dx = mx - (t.x + t.radius);
        const dy = my - (t.y + t.radius);
        if (dx * dx + dy * dy < (t.radius + 8) * (t.radius + 8)) return t;
      }
      return null;
    }

    this.canvas.addEventListener('mousedown', function(e) {
      const pos = canvasCoord(e);
      const toy = findToy(pos.x, pos.y);
      if (toy) {
        dragging = toy;
        arena._draggedToy = toy;
        dragOffX = pos.x - toy.x;
        dragOffY = pos.y - toy.y;
        lastMX = pos.x; lastMY = pos.y;
        lastDragTime = performance.now();
        toy.vx = 0; toy.vy = 0;
        e.stopPropagation();
        e.preventDefault();
      }
    });

    this.canvas.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      const pos = canvasCoord(e);
      const now = performance.now();
      const elapsed = Math.max(1, now - lastDragTime);
      // Track velocity from drag movement
      dragging.vx = (pos.x - lastMX) / elapsed * 0.8;
      dragging.vy = (pos.y - lastMY) / elapsed * 0.8;
      dragging.x = pos.x - dragOffX;
      dragging.y = pos.y - dragOffY;
      lastMX = pos.x; lastMY = pos.y;
      lastDragTime = now;
      e.preventDefault();
    });

    const stopDrag = function() {
      if (dragging) {
        // Clamp throw velocity
        const maxV = 0.3;
        if (dragging.vx > maxV) dragging.vx = maxV;
        if (dragging.vx < -maxV) dragging.vx = -maxV;
        if (dragging.vy > maxV) dragging.vy = maxV;
        if (dragging.vy < -maxV) dragging.vy = -maxV;

        // If released above the horizon, make it fall
        var horizY = arena.height * arena.horizonLine;
        if (dragging.y < horizY) {
          var gBottom = arena.height - 10;
          var minG = horizY + 20;
          var skyR = dragging.y / Math.max(1, horizY);
          dragging.groundY = minG + (gBottom - minG) * skyR * 0.9;
          dragging.airborne = true;
          dragging.arcMode = false;
          // Reset fall state so the timed fall system kicks in fresh
          dragging.fallStartY = undefined;
          dragging.fallProgress = undefined;
          dragging.bounceCount = undefined;
        }
      }
      dragging = null;
      arena._draggedToy = null;
    };
    this.canvas.addEventListener('mouseup', stopDrag);
    this.canvas.addEventListener('mouseleave', stopDrag);
  }

  // Drag-and-drop companions for picture-taking.
  _initCompanionDrag() {
    const arena = this;
    let dragging = null;
    let dragOffX = 0, dragOffY = 0;
    let lastMX = 0, lastMY = 0;
    let lastDragTime = 0;

    function canvasCoord(e) {
      const rect = arena.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (arena.width / rect.width),
        y: (e.clientY - rect.top) * (arena.height / rect.height),
      };
    }

    function findCompanionAt(mx, my) {
      // Iterate in reverse so the topmost companion gets picked
      // (later in this.companions array = drawn last = on top).
      for (let i = arena.companions.length - 1; i >= 0; i--) {
        const c = arena.companions[i];
        const dw = (c.data.frameSize[0] || 32) * c.scale;
        const dh = (c.data.frameSize[1] || 32) * c.scale;
        if (mx >= c.x && mx <= c.x + dw && my >= c.y && my <= c.y + dh) {
          return c;
        }
      }
      return null;
    }

    this.canvas.addEventListener('mousedown', function(e) {
      // If a toy grab already started, don't double-handle.
      if (arena._draggedToy) return;
      const pos = canvasCoord(e);
      const comp = findCompanionAt(pos.x, pos.y);
      if (!comp) return;

      dragging = comp;
      arena._draggedCompanion = comp;
      dragOffX = pos.x - comp.x;
      dragOffY = pos.y - comp.y;
      lastMX = pos.x; lastMY = pos.y;
      lastDragTime = performance.now();
      // Freeze autonomous behavior. stateTimer pushed far into the
      // future so the AI loop won't re-arm while the user drags.
      comp.state = 'idle';
      comp.animation = 'idle';
      comp.vx = 0; comp.vy = 0;
      comp.stateTimer = 60000; // 60s — well beyond a typical drag
      arena.canvas.style.cursor = 'grabbing';
      e.stopPropagation();
      e.preventDefault();
    });

    this.canvas.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      const pos = canvasCoord(e);
      const now = performance.now();
      const elapsed = Math.max(1, now - lastDragTime);
      // Track velocity from drag motion for a small throw on release.
      dragging._dragVx = (pos.x - lastMX) / elapsed * 0.8;
      dragging._dragVy = (pos.y - lastMY) / elapsed * 0.8;
      dragging.x = pos.x - dragOffX;
      dragging.y = pos.y - dragOffY;
      lastMX = pos.x; lastMY = pos.y;
      lastDragTime = now;
      e.preventDefault();
    });

    const stopDrag = function() {
      if (dragging) {
        // Throw velocity from drag motion — clamp like toys do so
        // a wild flick doesn't yeet the companion off-screen.
        const maxV = 0.35;
        let vx = dragging._dragVx || 0;
        let vy = dragging._dragVy || 0;
        if (vx >  maxV) vx =  maxV;
        if (vx < -maxV) vx = -maxV;
        if (vy >  maxV) vy =  maxV;
        if (vy < -maxV) vy = -maxV;
        dragging.vx = vx;
        dragging.vy = vy;
        // After the throw, let the companion idle for a moment
        // before re-arming its AI. This stops it from instantly
        // re-engaging a chase the moment the user releases.
        dragging.stateTimer = 1200 + Math.random() * 800;
        dragging.state = 'idle';
        dragging.animation = 'idle';
        dragging._dragVx = undefined;
        dragging._dragVy = undefined;
      }
      dragging = null;
      arena._draggedCompanion = null;
      arena.canvas.style.cursor = 'pointer';
    };
    this.canvas.addEventListener('mouseup', stopDrag);
    this.canvas.addEventListener('mouseleave', stopDrag);

    // Hover cursor — 'grab' over a companion so the user knows it's draggable, back to 'pointer' (set by _initClick) when not hovering one.
    this.canvas.addEventListener('mousemove', function(e) {
      if (arena._draggedCompanion) return;
      const pos = canvasCoord(e);
      const c = findCompanionAt(pos.x, pos.y);
      arena.canvas.style.cursor = c ? 'grab' : 'pointer';
    });
  }

  // ── TOY PHYSICS ─────────────────────────────────────────────

  _updateToys(dt) {
    // Always sync with global store (survives arena rebuilds)
    this.toys = window._arenaToys || [];
    
    const friction = 0.997; // per-ms ground friction multiplier
    const wallBounce = 0.7;
    const gravity = 0.00015; // gravity — tuned for ~1.5s visible fall
    const margin = 5;
    const horizonY = this.height * this.horizonLine;
    const groundBottom = this.height - margin;

    for (const toy of this.toys) {
      // Determine bounce coefficient based on toy type
      let groundBounce = 0.55; // default ball
      if (toy.type === 'tennis-ball') {
        groundBounce = 0.95; // insane bouncing!
      }

      var isDragged = (toy === this._draggedToy);
      if (isDragged) {
        toy.lastTouched = performance.now();
      }

      toy.age += dt;
      toy.bouncePhase += dt * 0.004;

      // Skip physics for dragged toy (user controls position)
      if (isDragged) {
        continue; // skip rest of physics
      }

      // Airborne physics — gravity pulls down toward groundY
      // === ARC MODE: companion kicked ball into the air ===
      if (toy.arcMode) {
        // Parametric arc from start to target
        toy.arcT += dt / toy.arcDuration;
        if (toy.arcT >= 1) {
          // Landed at target
          toy.arcT = 1;
          toy.x = toy.arcTargetX;
          toy.y = toy.arcTargetY;
          toy.arcMode = false;
          toy.airborne = false;
          toy.groundY = toy.arcTargetY;
          toy.vx = (Math.random() - 0.5) * 0.02; // tiny bounce on landing
          toy.vy = 0;
        } else {
          var t = toy.arcT;
          // Linear interpolation for X and Y base
          toy.x = toy.arcStartX + (toy.arcTargetX - toy.arcStartX) * t;
          var baseY = toy.arcStartY + (toy.arcTargetY - toy.arcStartY) * t;
          // Parabolic arc: peak at t=0.5, height = arcPeak
          var arcOffset = -4 * toy.arcPeak * t * (1 - t);
          toy.y = baseY + arcOffset;
        }
      }
      // === FALLING MODE: dropped from sky, falls with gravity ===
      else if (toy.airborne) {
        // Use a timed fall: smooth acceleration over ~1.5 seconds
        if (toy.fallStartY === undefined) {
          toy.fallStartY = toy.y;
          toy.fallProgress = 0;
          toy.fallDuration = 1200 + Math.random() * 400; // 1.2-1.6 sec
          toy.bounceCount = 0;
        }
        toy.fallProgress += dt;
        var t = Math.min(toy.fallProgress / toy.fallDuration, 1);
        // Ease-in quadratic (accelerating fall, like real gravity)
        var eased = t * t;
        toy.y = toy.fallStartY + (toy.groundY - toy.fallStartY) * eased;
        toy.x += toy.vx * dt; // horizontal drift if any

        // Hit the ground?
        if (t >= 1) {
          toy.y = toy.groundY;
          const maxBounces = toy.type === 'tennis-ball' ? 8 : 3; // tennis ball bounces more
          if (toy.bounceCount < maxBounces) {
            // Bounce back up
            toy.bounceCount++;
            var bounceHeight = (toy.groundY - toy.fallStartY) * groundBounce / toy.bounceCount;
            toy.fallStartY = toy.groundY - bounceHeight;
            toy.fallProgress = 0;
            toy.fallDuration = 400 / toy.bounceCount;
          } else {
            // Settled
            toy.airborne = false;
            toy.fallStartY = undefined;
          }
        }

        // Light air resistance
        toy.vx *= Math.pow(0.999, dt);
      }
      // === GROUND MODE: normal 2D sliding ===
      else {
        toy.x += toy.vx * dt;
        toy.y += toy.vy * dt;

        // Ground friction
        var f = Math.pow(friction, dt);
        toy.vx *= f;
        toy.vy *= f;

        // Stop when very slow
        if (Math.abs(toy.vx) < 0.0005 && Math.abs(toy.vy) < 0.0005) {
          toy.vx = 0; toy.vy = 0;
        }

        // Keep on ground plane
        if (toy.y < horizonY + 5) {
          toy.y = horizonY + 5;
          toy.vy = Math.abs(toy.vy) * groundBounce;
        }
        if (toy.y > groundBottom - toy.radius * 2) {
          toy.y = groundBottom - toy.radius * 2;
          toy.vy = -Math.abs(toy.vy) * groundBounce;
        }
      }

      // Wall bounce (left/right always applies)
      if (toy.x < margin) { toy.x = margin; toy.vx = Math.abs(toy.vx) * wallBounce; }
      if (toy.x > this.width - toy.radius * 2 - margin) {
        toy.x = this.width - toy.radius * 2 - margin;
        toy.vx = -Math.abs(toy.vx) * wallBounce;
      }
      // Top wall (sky ceiling)
      if (toy.y < margin) { toy.y = margin; toy.vy = Math.abs(toy.vy) * wallBounce; }

      // Track last movement for timeout
      const toySpeed = Math.sqrt(toy.vx * toy.vx + toy.vy * toy.vy);
      if (toySpeed > 0.005 || toy.airborne) {
        toy.lastTouched = performance.now();
      }

    }

    // Remove toys idle for 15 seconds (not moving + not touched).
    // v3.1.17: was 60000ms (60s); Tobe: 'make the toys disappear faster.'
    const now = performance.now();
    for (let i = this.toys.length - 1; i >= 0; i--) {
      const toy = this.toys[i];
      if (!toy.lastTouched) toy.lastTouched = now;
      const idleTime = now - toy.lastTouched;
      if (idleTime > 15000) this.toys.splice(i, 1);
    }
  }

  // ── UPDATE LOGIC ────────────────────────────────────────────

  // ─── Rocket toy (v3.6.7) ───────────────────────────────────────
  // Lies sideways on the ground. The nearest companion walks over, hops on,
  // the rocket rumbles, then blasts off on a wacky loop-de-loop flight and
  // leaves the arena. The rider respawns 10 s later.
  _spawnRocket(canvasX, canvasY) {
    const H = this.height, horizonY = H * this.horizonLine;
    const y = Math.max(horizonY + 30, Math.min(H - 24, canvasY));
    const x = Math.max(40, Math.min(this.width - 40, canvasX));
    const free = this.companions.filter(c => !c.hiddenUntil && !c.rocket && c !== this._draggedCompanion);
    const awake = free.filter(c => c.animation !== 'death');
    const pool = awake.length ? awake : free;
    let pick = null, best = Infinity;
    for (const c of pool) {
      const cx = c.x + (c.data.frameSize[0] * c.scale) / 2, cy = c.y + c.data.frameSize[1] * c.scale;
      const d = Math.hypot(cx - x, cy - y);
      if (d < best) { best = d; pick = c; }
    }
    const r = { x, y, phase: 'ground', t: 0, heading: 0, speed: 0, wob: Math.random() * 6, trail: [], riderId: pick ? pick.id : null };
    this.rockets.push(r);
    if (pick) {
      window._companionAwakeUntil = window._companionAwakeUntil || {};
      window._companionAwakeUntil[pick.id] = Date.now() + 60000;
      pick.rocket = r;
      pick.state = 'seek_rocket';
      this.companionEmoji = { emoji: '🚀', timer: 1500 };
    }
  }

  // Returns true when the rocket owns this companion this frame.
  _rocketControlsCompanion(comp, dt) {
    const now = Date.now();
    if (comp.hiddenUntil) {
      if (now < comp.hiddenUntil) return true;
      comp.hiddenUntil = 0;
      const dw = comp.data.frameSize[0] * comp.scale, dh = comp.data.frameSize[1] * comp.scale;
      const horizonY = this.height * this.horizonLine;
      comp.x = 20 + Math.random() * Math.max(10, this.width - dw - 40);
      comp.y = Math.max(horizonY - dh * 0.6, horizonY + Math.random() * Math.max(10, this.height - horizonY - dh) - dh * 0.6);
      comp.state = 'idle'; comp.animation = 'idle'; comp.vx = 0; comp.vy = 0; comp.frame = 0;
      comp.stateTimer = 2500;
      this.companionEmoji = { emoji: '✨', timer: 2000 };
      if (this.showBubble) this.showBubble(['WHAT A RIDE! 🚀', 'Again! Again!', "I can see my house from here... could.", 'My fur is still smoking.'][Math.floor(Math.random() * 4)], 3500);
      return false;
    }
    const r = comp.rocket;
    if (!r) return false;
    if (this.rockets.indexOf(r) < 0) { comp.rocket = null; if (comp.state === 'seek_rocket' || comp.state === 'riding') comp.state = 'idle'; return false; }
    const dw = comp.data.frameSize[0] * comp.scale, dh = comp.data.frameSize[1] * comp.scale;
    if (r.phase === 'ground') {
      const fx = comp.x + dw / 2, fy = comp.y + dh * 0.85;
      const dx = r.x - fx, dy = (r.y - 6) - fy, d = Math.hypot(dx, dy);
      if (d < 14) {
        r.phase = 'mount'; r.t = 0; comp.state = 'riding';
        comp.animation = 'idle'; comp.vx = 0; comp.vy = 0; comp.frame = 0;
        this.companionEmoji = { emoji: '😎', timer: 1400 };
      } else {
        const sp = 0.07;
        comp.vx = (dx / d) * sp; comp.vy = (dy / d) * sp;
        comp.x += comp.vx * dt; comp.y += comp.vy * dt;
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        comp.direction = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 2 : 3) : (dy < 0 ? 1 : 0);
      }
    } else {
      // mounted or flying: ride on top of the rocket
      if (r.phase === 'flying') {
        // v3.6.9: freaking out — flailing in every direction, still on the rocket.
        comp.panicT = (comp.panicT || 0) + dt;
        if (comp.panicT > 140) {
          comp.panicT = 0;
          comp.direction = Math.floor(Math.random() * 4);
          comp.panicDx = (Math.random() - 0.5) * 10;
          comp.panicDy = (Math.random() - 0.5) * 6;
        }
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        if (!r.yelled) {
          r.yelled = true;
          if (this.showBubble) this.showBubble(['Fuck! This may have been a bad decision!', 'Fuck! This may have been a bad decision!', 'AAAAAAHHHH!', 'Mom, come pick me up!'][Math.floor(Math.random() * 4)], 3500);
          this.companionEmoji = { emoji: '😱', timer: 3000 };
        }
      } else {
        comp.direction = 3; comp.panicDx = 0; comp.panicDy = 0;
      }
      comp.x = r.x - dw / 2 + (comp.panicDx || 0);
      comp.y = r.y - dh * 0.85 - 12 + (comp.panicDy || 0);
    }
    comp.frameTimer = (comp.frameTimer || 0) + dt;
    const anim = comp.images[comp.animation];
    if (anim && comp.frameTimer >= comp.frameSpeed) { comp.frameTimer = 0; comp.frame = (comp.frame + 1) % anim.frames; }
    return true;
  }

  _updateRockets(dt) {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.t += dt;
      const rider = r.riderId ? this.companions.find(c => c.id === r.riderId) : null;
      if (r.phase === 'ground') {
        if (!rider || r.t > 30000) { this.rockets.splice(i, 1); if (rider) rider.rocket = null; }
        continue;
      }
      if (r.phase === 'mount') {
        if (r.t > 1300) { r.phase = 'flying'; r.t = 0; r.heading = -0.35; r.speed = 0.18; }
        continue;
      }
      // flying — wobbly, looping, accelerating, then gone
      r.speed = Math.min(0.75, r.speed + dt * 0.00018);
      r.heading += (Math.sin(r.t * 0.004 + r.wob) * 0.0045 + (Math.random() - 0.5) * 0.004) * dt;
      const WACKY_MS = 4200; // bounce around inside the arena first, then escape
      if (r.t < WACKY_MS) r.heading -= 0.0016 * dt * Math.sign(Math.sin(r.t * 0.0011 + r.wob)); // loop-de-loops
      r.x += Math.cos(r.heading) * r.speed * dt;
      r.y += Math.sin(r.heading) * r.speed * dt;
      if (r.t < WACKY_MS) {
        if (r.y > this.height - 30) { r.y = this.height - 30; r.heading = -Math.abs(r.heading) - 0.4; }
        if (r.y < 30) { r.y = 30; r.heading = Math.abs(r.heading) + 0.4; }
        if (r.x < 30) { r.x = 30; r.heading = Math.PI - r.heading; }
        if (r.x > this.width - 30) { r.x = this.width - 30; r.heading = Math.PI - r.heading; }
        r.speed = Math.min(r.speed, 0.42);
      }
      r.trail.push({ x: r.x - Math.cos(r.heading) * 22, y: r.y - Math.sin(r.heading) * 22, a: 1 });
      if (r.trail.length > 28) r.trail.shift();
      for (const p of r.trail) p.a -= dt * 0.0016;
      const out = r.x < -120 || r.x > this.width + 120 || r.y < -140 || r.y > this.height + 120;
      if (out || r.t > 9000) {
        this.rockets.splice(i, 1);
        if (rider) { rider.rocket = null; rider.state = 'idle'; rider.hiddenUntil = Date.now() + 10000; }
      }
    }
  }

  _drawRockets() {
    const ctx = this.ctx;
    for (const r of this.rockets) {
      ctx.save();
      for (const p of r.trail) {
        if (p.a <= 0) continue;
        ctx.globalAlpha = Math.max(0, p.a) * 0.55;
        ctx.fillStyle = '#d8d8d8';
        ctx.beginPath(); ctx.arc(p.x, p.y, 4 + (1 - p.a) * 9, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      let jx = 0, jy = 0;
      if (r.phase === 'mount') { jx = (Math.random() - 0.5) * 3; jy = (Math.random() - 0.5) * 2; }
      if (r.phase === 'ground' || r.phase === 'mount') {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.ellipse(r.x, r.y + 14, 30, 6, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.translate(r.x + jx, r.y + jy);
      ctx.rotate((r.phase === 'flying' ? r.heading : 0) + Math.PI / 4); // 🚀 glyph points up-right
      // v3.6.9: bigger, and an opaque fillStyle — the shadow's rgba(0,0,0,0.22)
      // was still set here, so the rocket was nearly invisible on the ground.
      ctx.font = '52px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 1;
      ctx.fillText('🚀', 0, 0);
      if (r.phase !== 'ground') {
        ctx.rotate(-Math.PI / 4);
        ctx.font = (r.phase === 'flying' ? 22 + Math.random() * 8 : 12 + Math.random() * 6) + 'px serif';
        ctx.fillText('🔥', -36 - Math.random() * 5, 0);
      }
      ctx.restore();
    }
  }

  _updateCompanion(comp, dt) {
    // While the user is dragging this companion, skip the entire AI loop.
    if (this._draggedCompanion === comp) {
      comp.frameTimer += dt;
      const animData = comp.images[comp.animation];
      if (animData && comp.frameTimer >= comp.frameSpeed) {
        comp.frameTimer = 0;
        comp.frame = (comp.frame + 1) % animData.frames;
      }
      return;
    }
    if (this._rocketControlsCompanion(comp, dt)) return;
    // ── SLEEP MODE ──────────────────────────────────────────── v3.1.4: two sources of sleep: 1.
    const manualSleep = comp.sleepState === 'sleeping';
    const isNight = (typeof window.isNightTime === 'function')
      ? window.isNightTime()
      : (() => { const h = new Date().getHours(); return h >= 22 || h < 8; })();
    const awakeForWork = ((window._companionAwakeUntil || {})[comp.id] || 0) > Date.now();
    const timeBasedSleep = isNight && !window._nightWakeTimer && !awakeForWork;
    const isAsleep = manualSleep || timeBasedSleep;
    if (isAsleep) {
      if (comp.animation !== 'death') {
        comp.animation = 'death';
        comp.vx = 0;
        comp.vy = 0;
        comp.state = 'idle';
        // Hold on last frame of death anim
        const deathAnim = comp.images['death'];
        if (deathAnim) comp.frame = deathAnim.frames - 1;
      }
      return; // Skip all movement/state logic while sleeping
    }
    // Resume from sleep — back to idle. Don't clobber a different
    // animation the user triggered (e.g. walk) and don't wake a
    // manually-sleeping companion.
    if (comp.animation === 'death' && !manualSleep && !timeBasedSleep) {
      comp.animation = 'idle';
      comp.frame = 0;
    }

    // Frame animation
    comp.frameTimer += dt;
    const animData = comp.images[comp.animation];
    if (animData && comp.frameTimer >= comp.frameSpeed) {
      comp.frameTimer = 0;
      comp.frame = (comp.frame + 1) % animData.frames;
    }

    // Check for nearby treats — companion seeks food (only after grace period)
    const edibleTreats = this.treats.filter(t => t.graceTimer <= 0);
    if (edibleTreats.length > 0) {
      const fw = (comp.data.frameSize[0] || 32) * comp.scale;
      const fh = (comp.data.frameSize[1] || 32) * comp.scale;
      const compCX = comp.x + fw / 2;
      const compCY = comp.y + fh / 2;

      // Find nearest edible treat
      let nearest = null;
      let nearDist = Infinity;
      for (const treat of edibleTreats) {
        const dx = (treat.x + 14) - compCX;
        const dy = (treat.y + 14) - compCY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < nearDist) { nearest = treat; nearDist = dist; }
      }

      if (nearest) {
        if (nearDist < 30) {
          // Eat the treat!
          const eatenType = nearest.type;
          const eatIdx = this.treats.indexOf(nearest);
          if (eatIdx >= 0) this.treats.splice(eatIdx, 1);
          comp.state = 'idle';
          comp.animation = 'idle';
          comp.vx = 0;
          comp.vy = 0;
          comp.stateTimer = 2000;
          // Show happy emoji
          this.companionEmoji = { emoji: '😋', timer: 2500 };
          // After eating, show hearts
          setTimeout(() => { this.companionEmoji = { emoji: '❤️', timer: 1500 }; }, 2500);
          // Happiness boost
          if (window.adjustHappiness) window.adjustHappiness(5);
          // Prompt companion reaction for eating
          if (window.promptCompanionEat) window.promptCompanionEat(eatenType);
        } else {
          // Walk toward treat
          comp.state = 'seek';
          comp.animation = 'walk';
          const dx = (nearest.x + 14) - compCX;
          const dy = (nearest.y + 14) - compCY;
          const speed = 0.035;
          comp.vx = (dx / nearDist) * speed;
          comp.vy = (dy / nearDist) * speed;
          // Direction: 0=down, 1=up, 2=left, 3=right
          if (Math.abs(dx) > Math.abs(dy)) {
            comp.direction = dx < 0 ? 2 : 3;
          } else {
            comp.direction = dy < 0 ? 1 : 0;
          }
          comp.stateTimer = 200; // keep seeking
        }
        // Skip normal AI
      }
    }

    // Chase toys when no food treats around (and not seeking food)
    // v3.6.7: a chase that loses its toy (kicked away, despawned, out of range)
    // used to keep running forever — the state machine skips chase_toy.
    let sawToy = false;
    if (comp.state !== 'seek' && this.toys.length > 0) {
      const fw2 = (comp.data.frameSize[0] || 32) * comp.scale;
      const fh2 = (comp.data.frameSize[1] || 32) * comp.scale;
      const compCX2 = comp.x + fw2 / 2;
      const compCY2 = comp.y + fh2 / 2;
      // v3.1.17: lazily set the companion's body radius from sprite
      // width on first update. Used by the companion↔companion
      // hitbox collision below.
      if (!comp.bodyRadius) comp.bodyRadius = fw2 * 0.45;

      // Per-companion chase personality.
      const cp = comp.chasePersonality;
      const reactionLag = cp.reactionDelay;

      // Find nearest stopped or slow-moving toy
      let nearToy = null;
      let nearToyDist = Infinity;
      for (const toy of this.toys) {
        if (toy === this._draggedToy) continue;
        // Skip toys outside this companion's reaction radius —
        // some companions are short-sighted, others eagle-eyed.
        const dx = (toy.x + toy.radius) - compCX2;
        const dy = (toy.y + toy.radius) - compCY2;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // ReactRadius (60–180 px) was tuned for a ~500 px arena; on the current ~1300 px arena a thrown ball was almost never noticed.
        const fresh = (performance.now() - (toy.lastTouched || 0)) < 6000;
        const radius = cp.reactRadius * Math.max(1, this.width / 500);
        if (!fresh && dist > radius) continue;
        if (dist < nearToyDist) { nearToy = toy; nearToyDist = dist; }
      }

      if (nearToy) {
        sawToy = true;
        if (nearToyDist < 35) {
          nearToy.lastTouched = performance.now();
          nearToy.fallStartY = undefined; // reset fall state

          if (Math.random() < 0.5) {
            // === GROUND KICK: fast push along ground ===
            var baseAngle = Math.atan2(nearToy.y + nearToy.radius - compCY2, nearToy.x + nearToy.radius - compCX2);
            var kickAngle = baseAngle + (Math.random() - 0.5) * 1.4;
            var kickPower = 0.10 + Math.random() * 0.12;
            nearToy.vx = Math.cos(kickAngle) * kickPower;
            nearToy.vy = Math.sin(kickAngle) * kickPower;
            nearToy.arcMode = false;
            nearToy.airborne = false;
          } else {
            // === ARC KICK: boot it into the air ===
            var kickHorizon = this.height * this.horizonLine;
            var kickTargetX = 30 + Math.random() * (this.width - 60);
            var kickTargetY = kickHorizon + 20 + Math.random() * (this.height - kickHorizon - 40);
            nearToy.arcMode = true;
            nearToy.arcStartX = nearToy.x;
            nearToy.arcStartY = nearToy.y;
            nearToy.arcTargetX = kickTargetX;
            nearToy.arcTargetY = kickTargetY;
            nearToy.arcT = 0;
            var kickDist = Math.sqrt(Math.pow(kickTargetX - nearToy.x, 2) + Math.pow(kickTargetY - nearToy.y, 2));
            nearToy.arcDuration = 800 + Math.min(kickDist * 3, 1200);
            nearToy.arcPeak = 40 + Math.random() * 60 + kickDist * 0.15;
            nearToy.airborne = true;
            nearToy.vx = 0; nearToy.vy = 0;
          }

          comp.state = 'idle';
          comp.animation = 'idle';
          comp.vx = 0; comp.vy = 0;
          comp.stateTimer = 1000 + Math.random() * 1500;
          this.companionEmoji = { emoji: '⚽', timer: 2000 };
          if (window.adjustHappiness) window.adjustHappiness(3);
        } else {
          // Chase the toy — speed depends on distance
          const toySpeed = Math.sqrt(nearToy.vx * nearToy.vx + nearToy.vy * nearToy.vy);
          if (toySpeed < 0.10) {
            comp.state = 'chase_toy';
            comp.animation = comp.images['run'] ? 'run' : 'walk';
            const dx = (nearToy.x + nearToy.radius) - compCX2;
            const dy = (nearToy.y + nearToy.radius) - compCY2;
            // Run faster when far away, slow down when close
            var chaseSpeed;
            if (nearToyDist > 200) {
              chaseSpeed = (0.09 + Math.random() * 0.03) * cp.speedMult; // sprint
            } else if (nearToyDist > 80) {
              chaseSpeed = (0.055 + Math.random() * 0.02) * cp.speedMult; // run
            } else {
              chaseSpeed = 0.035 * cp.speedMult; // approach carefully
            }
            comp.vx = (dx / nearToyDist) * chaseSpeed;
            comp.vy = (dy / nearToyDist) * chaseSpeed;
            if (Math.abs(dx) > Math.abs(dy)) {
              comp.direction = dx < 0 ? 2 : 3;
            } else {
              comp.direction = dy < 0 ? 1 : 0;
            }
            // ReactionDelay adds a small lag before this companion commits to the chase — so two companions seeing the same toy don't both arrive at the…
            comp.stateTimer = 150 + (cp.reactionDelay || 0);
          }
        }
      }
    }

    // Update emoji timer
    if (comp.state === 'chase_toy') {
      comp.chaseMs = (comp.chaseMs || 0) + dt;
      if (!sawToy || comp.chaseMs > 8000) {
        comp.state = 'idle'; comp.animation = 'idle'; comp.vx = 0; comp.vy = 0;
        comp.stateTimer = 1200 + Math.random() * 1500; comp.chaseMs = 0;
      }
    } else comp.chaseMs = 0;

    if (this.companionEmoji) {
      this.companionEmoji.timer -= dt;
      if (this.companionEmoji.timer <= 0) this.companionEmoji = null;
    }

    // Track boredom — increases when idle with no toys
    if (!comp.boredom) comp.boredom = 0;
    var hasToys = this.toys.length > 0;

    // AI state machine (skip if seeking treat or chasing toy)
    if (comp.state !== 'seek' && comp.state !== 'chase_toy') {
    comp.stateTimer -= dt;
    if (comp.stateTimer <= 0) {
      // Boredom increases when idle without toys
      if (comp.state === 'idle' && !hasToys) {
        comp.boredom += 15 + Math.random() * 10;
      } else if (hasToys) {
        comp.boredom = Math.max(0, comp.boredom - 20);
      }

      const roll = Math.random();

      if (comp.boredom > 80 && !hasToys && Math.random() < 0.4) {
        // BORED — run around excitedly, then ask to play
        comp.state = 'bored_run';
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.07 + Math.random() * 0.04;
        const dirs = [[0, 1], [0, -1], [-1, 0], [1, 0]];
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 1500 + Math.random() * 1500;
        this.companionEmoji = { emoji: '🥺', timer: 2500 };
        // Ask to play via chat bubble
        if (this.showBubble) {
          var playPhrases = [
            "Play with me!", "I'm bored...", "Throw me a ball! ⚽",
            "Let's play!", "Wanna play?", "I need a toy! 🎾"
          ];
          this.showBubble(playPhrases[Math.floor(Math.random() * playPhrases.length)], 4000, comp.id);
        }
        comp.boredom = 0; // reset after expressing it
      } else if (roll < 0.45) {
        // Idle — chill in one spot
        comp.state = 'idle';
        comp.animation = 'idle';
        comp.vx = 0;
        comp.vy = 0;
        comp.stateTimer = 3000 + Math.random() * 5000;
      } else if (roll < 0.75) {
        // Gentle walk
        comp.state = 'walk';
        comp.animation = 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.015 + Math.random() * 0.01;
        const dirs = [[0, 1], [0, -1], [-1, 0], [1, 0]];
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 2000 + Math.random() * 4000;
      } else if (roll < 0.90) {
        // Run around — energetic burst
        comp.state = 'run';
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.06 + Math.random() * 0.04;
        const dirs = [[0, 1], [0, -1], [-1, 0], [1, 0]];
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 1000 + Math.random() * 2000;
      } else {
        // Excited zoomies — fast dash in a random direction
        comp.state = 'run';
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.08 + Math.random() * 0.05;
        comp.vx = Math.cos(angle) * speed;
        comp.vy = Math.sin(angle) * speed;
        comp.direction = Math.abs(comp.vx) > Math.abs(comp.vy) ? (comp.vx > 0 ? 3 : 2) : (comp.vy > 0 ? 0 : 1);
        comp.stateTimer = 600 + Math.random() * 800;
      }
      comp.frame = 0;
      comp.frameTimer = 0;
    }
    } // end if not seeking

    // Update facing direction based on actual velocity
    // Sprite rows: 0=down, 1=up, 2=left, 3=right
    var amx = Math.abs(comp.vx);
    var amy = Math.abs(comp.vy);
    if (amx > 0.002 || amy > 0.002) {
      // Prefer left/right (side sprites look better for diagonal movement)
      // Only use up/down when vertical is clearly dominant (>2x horizontal)
      if (amy > amx * 2.0) {
        comp.direction = comp.vy > 0 ? 0 : 1; // down : up
      } else {
        comp.direction = comp.vx < 0 ? 2 : 3; // left : right
      }
    }

    // Move
    comp.x += comp.vx * dt;
    comp.y += comp.vy * dt;

    // Bounds — companion stays below horizon line
    const fw = (comp.data.frameSize[0] || 32) * comp.scale;
    const fh = (comp.data.frameSize[1] || 32) * comp.scale;
    const margin = 20;
    const horizonY = this.height * this.horizonLine;

    // Hard bounds — companion can clip into sides/bottom, walks ON the horizon Feet at comp.y + fh.
    const minY = horizonY - fh * 0.90;
    // Bottom/sides: allow clipping — only bounce when center goes past edge
    const halfW = fw / 2;
    const halfH = fh / 2;
    if (comp.x + halfW < 0) { comp.x = -halfW; comp.vx = Math.abs(comp.vx); }
    if (comp.x + halfW > this.width) { comp.x = this.width - halfW; comp.vx = -Math.abs(comp.vx); }
    if (comp.y < minY) { comp.y = minY; comp.vy = Math.abs(comp.vy); }
    if (comp.y + halfH > this.height) { comp.y = this.height - halfH; comp.vy = -Math.abs(comp.vy); }

    // Companion↔companion hitbox collision.
    if (!comp.bodyRadius) comp.bodyRadius = halfW * 0.9;
    const compCX = comp.x + halfW;
    const compCY = comp.y + halfH;
    for (const other of this.companions) {
      if (other === comp) continue;
      const oFw = (other.data.frameSize[0] || 32) * other.scale;
      const oFh = (other.data.frameSize[1] || 32) * other.scale;
      const oHalfW = oFw / 2;
      const oHalfH = oFh / 2;
      if (!other.bodyRadius) other.bodyRadius = oHalfW * 0.9;
      const oCX = other.x + oHalfW;
      const oCY = other.y + oHalfH;
      const dx = compCX - oCX;
      const dy = compCY - oCY;
      const d2 = dx * dx + dy * dy;
      const minD = comp.bodyRadius + other.bodyRadius;
      if (d2 >= minD * minD || d2 < 0.0001) continue;
      const d = Math.sqrt(d2);
      const overlap = (minD - d) * 0.5;
      const nx = dx / d;
      const ny = dy / d;
      // Position separation (split the overlap between the two
      // companions so neither one teleports through the other).
      comp.x += nx * overlap;
      comp.y += ny * overlap;
      other.x -= nx * overlap;
      other.y -= ny * overlap;
      // Velocity separation along the contact normal. Damp the
      // component of velocity pointing INTO the other companion
      // and add a small bounce-away component.
      const compVN = comp.vx * nx + comp.vy * ny;
      const otherVN = other.vx * nx + other.vy * ny;
      // If both are moving toward each other (or one is), bounce
      // the relative-velocity component back. Use a soft restitution
      // so they don't ping-pong violently.
      const restitution = 0.35;
      if (compVN - otherVN < 0) {
        const impulse = -(1 + restitution) * (compVN - otherVN) * 0.5;
        comp.vx += impulse * nx;
        comp.vy += impulse * ny;
        other.vx -= impulse * nx;
        other.vy -= impulse * ny;
      }
    }
  }

  // ── DRAW ────────────────────────────────────────────────────

  _drawCompanion(comp) {
    if (comp.hiddenUntil) return; // flew off on a rocket
    const animData = comp.images[comp.animation] || comp.images['idle'];
    if (!animData) return;

    const [fw, fh] = comp.data.frameSize;
    const cols = animData.cols || animData.frames;
    // v3.4.7: some sheets order their rows differently (the fox run
    // sheet has left/right swapped → moonwalking). catalog.json can
    // give a per-animation rowMap [down, up, left, right].
    const row = animData.rowMap ? animData.rowMap[comp.direction] : comp.direction;
    const col = comp.frame % cols;

    const sx = col * fw;
    const sy = row * fh;
    const dw = fw * comp.scale;
    const dh = fh * comp.scale;

    // Sprite
    this.ctx.imageSmoothingEnabled = false;
    if (!animData.img || !animData.img.complete || animData.img.naturalWidth === 0) return;
    this.ctx.drawImage(animData.img, sx, sy, fw, fh, comp.x, comp.y, dw, dh);

    // Name label — golden, prominent
    this.ctx.fillStyle = '#ff9900';
    this.ctx.font = 'bold 14px Orbitron, monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(comp.name, comp.x + dw / 2, comp.y - 10);

    // Crown indicator (or emoji if reacting)
    if (this.companionEmoji) {
      const emojiScale = 1 + Math.sin(performance.now() * 0.005) * 0.15;
      this.ctx.font = (20 * emojiScale) + 'px serif';
      this.ctx.fillText(this.companionEmoji.emoji, comp.x + dw / 2, comp.y - 28);
    }
  }

  _drawGround() {
    if (this.bgImage && this.bgImage.complete && this.bgImage.naturalWidth > 0) {
      // Draw background image covering the whole arena
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.bgImage, 0, 0, this.width, this.height);
      return;
    }

    // Fallback: simple ground
    this.ctx.fillStyle = this.groundColor;
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Grass patches
    for (const g of this.grassPatches) {
      const green = Math.floor(40 + g.shade * 30);
      this.ctx.fillStyle = `rgb(${10 + g.shade * 10}, ${green}, ${10 + g.shade * 5})`;
      this.ctx.fillRect(g.x, g.y, g.size, g.size * 0.6);
    }
  }

  // ── ANIMATION LOOP ──────────────────────────────────────────

  _animate() {
    const now = performance.now();
    const dt = Math.min(now - this.lastTime, 100); // Cap at 100ms to prevent teleporting on lag
    this.lastTime = now;

    // Update
    for (const c of this.companions) this._updateCompanion(c, dt);
    this._updateToys(dt);
    this._updateRockets(dt);

    // Update treat age and grace timer
    for (const treat of this.treats) {
      treat.age += dt;
      treat.bouncePhase += dt * 0.005;
      if (treat.graceTimer > 0) treat.graceTimer -= dt;
    }
    // Remove old treats (60 seconds) — mutate in place to keep global ref
    for (let i = this.treats.length - 1; i >= 0; i--) {
      if (this.treats[i].age >= 60000) this.treats.splice(i, 1);
    }

    // Draw
    this._drawGround();

    // Draw treats on ground
    this.ctx.globalAlpha = 1; // Ensure full opacity for treats
    for (const treat of this.treats) {
      const bounce = Math.sin(treat.bouncePhase) * 2;
      this.ctx.font = '31px serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillStyle = '#ffffff'; // Ensure white fill
      this.ctx.fillText(treat.emoji, treat.x + 16, treat.y + 16 + bounce);
      // Small shadow
      this.ctx.fillStyle = 'rgba(0,0,0,0.25)';
      this.ctx.beginPath();
      this.ctx.ellipse(treat.x + 16, treat.y + 26, 10, 4, 0, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Draw toys on ground (physics objects)
    this.ctx.globalAlpha = 1;
    for (const toy of this.toys) {
      const spin = toy.bouncePhase * 2;
      const speed = Math.sqrt(toy.vx * toy.vx + toy.vy * toy.vy);
      // Only wobble on ground movement, not while falling
      const wobble = (speed > 0.01 && !toy.airborne && !toy.arcMode) ? Math.sin(spin) * 3 : 0;
      this.ctx.save();
      this.ctx.globalAlpha = 1;
      this.ctx.font = '31px serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillText(toy.emoji, toy.x + toy.radius + wobble, toy.y + toy.radius);
      // Shadow — bigger when moving fast
      const shadowSize = 10 + Math.min(speed * 100, 8);
      this.ctx.fillStyle = 'rgba(0,0,0,0.2)';
      this.ctx.beginPath();
      this.ctx.ellipse(toy.x + toy.radius, toy.y + toy.radius + 14, shadowSize, 4, 0, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    this._drawRockets();

    // Collect all entities for Y-sort depth ordering
    const entities = [];
    for (const c of this.companions) {
      entities.push({ type: 'companion', obj: c, y: c.y + (c.data.frameSize[1] * c.scale) });
    }
    entities.sort((a, b) => a.y - b.y);

    for (const ent of entities) {
      this._drawCompanion(ent.obj);
    }

    // Update speech bubble position
    if (this.bubbleEl) this._updateBubblePosition();

    this.animId = requestAnimationFrame(() => this._animate());
  }

  dispose() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    // v3.1.5: support multiple companions. this.companions is the array;
    // this.companion is a convenience ref to the first one for back-compat.
    this.companions = [];
    this.companion = null;
  }

  // ── GET ENTITY BOUNDS (for camera crop) ─────────────────────

  getEntityBounds(agentId) {
    // v3.1.5: search all companions
    for (const c of this.companions) {
      if (c.id === agentId) {
        const dw = (c.data.frameSize[0] || 32) * c.scale;
        const dh = (c.data.frameSize[1] || 32) * c.scale;
        return { x: c.x, y: c.y, w: dw, h: dh };
      }
    }
    return null;
  }

  // Render a cropped view of the arena centered on an entity
  renderCameraView(targetCanvas, agentId, zoom) {
    if (!this.canvas) return;
    const bounds = this.getEntityBounds(agentId);

    const ctx = targetCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

    if (!bounds) {
      // Fallback: show whole arena
      ctx.drawImage(this.canvas, 0, 0, targetCanvas.width, targetCanvas.height);
      return;
    }

    const z = zoom || 2;
    const srcW = targetCanvas.width / z;
    const srcH = targetCanvas.height / z;
    const cx = bounds.x + bounds.w / 2 - srcW / 2;
    const cy = bounds.y + bounds.h / 2 - srcH / 2;

    // Clamp to arena bounds
    const sx = Math.max(0, Math.min(cx, this.width - srcW));
    const sy = Math.max(0, Math.min(cy, this.height - srcH));

    ctx.drawImage(this.canvas, sx, sy, srcW, srcH, 0, 0, targetCanvas.width, targetCanvas.height);
  }

  // ── EXPORT STATE (for pop-out window) ───────────────────────

  getState() {
    return {
      companionId: this.companion?.pixelCompanionId,
      companionName: this.companion?.name,
      companionAgentId: this.companion?.id,
      horizonLine: this.horizonLine,
    };
  }
}

// Export globally
window.PixelArena = PixelArena;
try { _fs.appendFileSync(_path.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] PixelArena exported OK\n`); } catch {}
