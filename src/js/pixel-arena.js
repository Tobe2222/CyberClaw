try { require('fs').appendFileSync(require('path').join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] pixel-arena.js TOP\n`); } catch {}
/* ============================================================
   PixelArena — Shared 2D arena with Companion + Spirits
   
   Companion = main agent (party leader), large pixel sprite, center
   Spirits   = helper agents, small spirit PNG sprites, orbit around
   ============================================================ */

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
    this.companion = null;
    // Spirits (spirit PNGs, small, orbiting)
    this.spirits = [];
    
    this.animId = null;
    this.lastTime = 0;

    // Background image + horizon
    this.bgImage = null;
    this.horizonLine = 0.5; // fraction of canvas height — companions stay below this

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
    this._draggedToy = null; // currently dragged toy

    // Speech bubble
    this.bubbleEl = null;
    this.bubbleTimer = null;

    this._resize();
    this._generateGrass();
    this._initResize();
    this._initClick();
    this._initToyDrag();
    this._animate();
  }

  _initClick() {
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (this.width / rect.width);
      const my = (e.clientY - rect.top) * (this.height / rect.height);

      // Check spirits first (they're on top visually at smaller size)
      for (const spirit of this.spirits) {
        if (mx >= spirit.x && mx <= spirit.x + spirit.size &&
            my >= spirit.y && my <= spirit.y + spirit.size) {
          if (this.onSelect) this.onSelect(spirit.id);
          return;
        }
      }

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

  async setCompanion(agentId, pixelCompanionId, name) {
    const catalog = loadPixelCatalog();
    const compData = catalog.companions.find(c => c.id === pixelCompanionId);
    if (!compData) return;

    // Load sprite images
    const assetsDir = window._assetsDir || _path.join(__dirname, '..', 'assets');
    const basePath = _path.join(assetsDir, 'pixel-companions', compData.folder);
    const images = {};

    for (const [animName, animData] of Object.entries(compData.animations)) {
      const imgPath = _path.join(basePath, animData.file);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => resolve(); // don't crash on missing anims
        img.src = `file://${imgPath}`;
      });
      images[animName] = { img, frames: animData.frames, cols: animData.cols || animData.frames };
    }

    this.companion = {
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
      scale: 5, // big companion
    };
  }

  // ── SPIRITS (helpers, spirit PNGs) ────────────────────────

  async addSpirit(agentId, spiritId, name) {
    if (this.spirits.find(s => s.id === agentId)) return;

    // Load spirit PNG
    const assetsDir = window._assetsDir || _path.join(__dirname, '..', 'assets');
    const imgPath = _path.join(assetsDir, 'spirits', `${spiritId}.png`);
    let img = null;
    try {
      img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `file://${imgPath}`;
      });
    } catch {
      return; // skip if image missing
    }

    // Random position spread across the arena
    const cx = this.width * (0.2 + Math.random() * 0.6);
    const cy = this.height * (0.15 + Math.random() * 0.6);
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 60;

    this.spirits.push({
      id: agentId,
      name: name || spiritId,
      spiritId,
      img,
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      vx: 0,
      vy: 0,
      size: 36 + Math.random() * 12, // small spirit size
      state: 'idle',
      stateTimer: 1000 + Math.random() * 4000,
      bobPhase: Math.random() * Math.PI * 2, // floating bob
      wanderAngle: Math.random() * Math.PI * 2,
    });
  }

  removeSpirit(agentId) {
    this.spirits = this.spirits.filter(s => s.id !== agentId);
  }

  // ── SPEECH BUBBLE ────────────────────────────────────────────

  showBubble(text, durationMs) {
    if (this.bubbleEl) {
      this.bubbleEl.remove();
      this.bubbleEl = null;
    }
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);

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

  static TOY_TYPES = ['ball', 'yarn', 'stick', 'frisbee', 'bell', 'feather'];

  dropTreat(canvasX, canvasY, treatType, emoji) {
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
        radius: 16,
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
      }
      dragging = null;
      arena._draggedToy = null;
    };
    this.canvas.addEventListener('mouseup', stopDrag);
    this.canvas.addEventListener('mouseleave', stopDrag);
  }

  // ── TOY PHYSICS ─────────────────────────────────────────────

  _updateToys(dt) {
    // Always sync with global store (survives arena rebuilds)
    this.toys = window._arenaToys || [];
    
    const friction = 0.997; // per-ms ground friction multiplier
    const wallBounce = 0.7;
    const groundBounce = 0.55;
    const gravity = 0.00015; // gravity — tuned for ~1.5s visible fall
    const margin = 5;
    const horizonY = this.height * this.horizonLine;
    const groundBottom = this.height - margin;

    for (const toy of this.toys) {
      var isDragged = (toy === this._draggedToy);
      if (isDragged) {
        toy.lastTouched = performance.now();
      }

      toy.age += dt;
      toy.bouncePhase += dt * 0.004;

      // Skip physics for dragged toy (user controls position) but still do collisions below
      if (isDragged) {
        // Collide dragged toy with spirits
        var dToyCX = toy.x + toy.radius;
        var dToyCY = toy.y + toy.radius;
        var dSpeed = Math.sqrt(toy.vx * toy.vx + toy.vy * toy.vy);
        var dForce = Math.max(dSpeed, 0.06); // dragged = always strong push
        for (var si = 0; si < this.spirits.length; si++) {
          var sp = this.spirits[si];
          var sdx = (sp.x + sp.size / 2) - dToyCX;
          var sdy = (sp.y + sp.size / 2) - dToyCY;
          var sdist = Math.sqrt(sdx * sdx + sdy * sdy);
          var shitDist = toy.radius + sp.size / 2;
          if (sdist < shitDist && sdist > 0) {
            sp.vx += (sdx / sdist) * dForce;
            sp.vy += (sdy / sdist) * dForce;
          }
        }
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
          if (toy.bounceCount < 3) {
            // Bounce back up
            toy.bounceCount++;
            var bounceHeight = (toy.groundY - toy.fallStartY) * 0.25 / toy.bounceCount;
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
          toy.vy = Math.abs(toy.vy) * 0.3;
        }
        if (toy.y > groundBottom - toy.radius * 2) {
          toy.y = groundBottom - toy.radius * 2;
          toy.vy = -Math.abs(toy.vy) * 0.3;
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

      // Collide with spirits — knock them sideways (any moving toy, including falling)
      const toyCX = toy.x + toy.radius;
      const toyCY = toy.y + toy.radius;
      if (toySpeed > 0.003 || toy.airborne) {
        const effectiveSpeed = Math.max(toySpeed, 0.03); // minimum knock force
        for (const spirit of this.spirits) {
          const sCX = spirit.x + spirit.size / 2;
          const sCY = spirit.y + spirit.size / 2;
          const dx = sCX - toyCX;
          const dy = sCY - toyCY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const hitDist = toy.radius + spirit.size / 2;
          if (dist < hitDist && dist > 0) {
            const knockForce = effectiveSpeed * 1.5;
            spirit.vx += (dx / dist) * knockForce;
            spirit.vy += (dy / dist) * knockForce;
            toy.vx *= 0.6;
            toy.vy *= 0.6;
          }
        }
      }
    }

    // Remove toys idle for 20 seconds (not moving + not touched)
    const now = performance.now();
    for (let i = this.toys.length - 1; i >= 0; i--) {
      const toy = this.toys[i];
      if (!toy.lastTouched) toy.lastTouched = now;
      const idleTime = now - toy.lastTouched;
      if (idleTime > 20000) this.toys.splice(i, 1);
    }
  }

  // ── UPDATE LOGIC ────────────────────────────────────────────

  _updateCompanion(comp, dt) {
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
          // Direction: 0=down, 1=left, 2=right, 3=up
          if (Math.abs(dx) > Math.abs(dy)) {
            comp.direction = dx < 0 ? 1 : 2;
          } else {
            comp.direction = dy < 0 ? 3 : 0;
          }
          comp.stateTimer = 200; // keep seeking
        }
        // Skip normal AI
      }
    }

    // Chase toys when no food treats around (and not seeking food)
    if (comp.state !== 'seek' && this.toys.length > 0) {
      const fw2 = (comp.data.frameSize[0] || 32) * comp.scale;
      const fh2 = (comp.data.frameSize[1] || 32) * comp.scale;
      const compCX2 = comp.x + fw2 / 2;
      const compCY2 = comp.y + fh2 / 2;

      // Find nearest stopped or slow-moving toy
      let nearToy = null;
      let nearToyDist = Infinity;
      for (const toy of this.toys) {
        if (toy === this._draggedToy) continue;
        const dx = (toy.x + toy.radius) - compCX2;
        const dy = (toy.y + toy.radius) - compCY2;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < nearToyDist) { nearToy = toy; nearToyDist = dist; }
      }

      if (nearToy) {
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
        } else if (nearToyDist < 400) {
          // Run toward the toy
          const toySpeed = Math.sqrt(nearToy.vx * nearToy.vx + nearToy.vy * nearToy.vy);
          // Only chase if toy is slow enough to catch
          if (toySpeed < 0.08) {
            comp.state = 'chase_toy';
            comp.animation = comp.images['run'] ? 'run' : 'walk';
            const dx = (nearToy.x + nearToy.radius) - compCX2;
            const dy = (nearToy.y + nearToy.radius) - compCY2;
            const chaseSpeed = 0.045;
            comp.vx = (dx / nearToyDist) * chaseSpeed;
            comp.vy = (dy / nearToyDist) * chaseSpeed;
            if (Math.abs(dx) > Math.abs(dy)) {
              comp.direction = dx < 0 ? 1 : 2;
            } else {
              comp.direction = dy < 0 ? 3 : 0;
            }
            comp.stateTimer = 200;
          }
        }
      }
    }

    // Update emoji timer
    if (this.companionEmoji) {
      this.companionEmoji.timer -= dt;
      if (this.companionEmoji.timer <= 0) this.companionEmoji = null;
    }

    // AI state machine — mostly idle, sometimes wander (skip if seeking treat or chasing toy)
    if (comp.state !== 'seek' && comp.state !== 'chase_toy') {
    comp.stateTimer -= dt;
    if (comp.stateTimer <= 0) {
      const roll = Math.random();
      if (roll < 0.5) {
        // Idle — stay center-ish
        comp.state = 'idle';
        comp.animation = 'idle';
        comp.vx = 0;
        comp.vy = 0;
        comp.stateTimer = 3000 + Math.random() * 5000;
      } else if (roll < 0.85) {
        // Gentle walk
        comp.state = 'walk';
        comp.animation = 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.015 + Math.random() * 0.01;
        const dirs = [[0, 1], [-1, 0], [1, 0], [0, -1]];
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 2000 + Math.random() * 3000;
      } else {
        // Brief run
        comp.state = 'run';
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.04 + Math.random() * 0.02;
        const dirs = [[0, 1], [-1, 0], [1, 0], [0, -1]];
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 800 + Math.random() * 1200;
      }
      comp.frame = 0;
      comp.frameTimer = 0;
    }
    } // end if not seeking

    // Move
    comp.x += comp.vx * dt;
    comp.y += comp.vy * dt;

    // Bounds — companion stays below horizon line
    const fw = (comp.data.frameSize[0] || 32) * comp.scale;
    const fh = (comp.data.frameSize[1] || 32) * comp.scale;
    const margin = 20;
    const horizonY = this.height * this.horizonLine;

    // Hard bounds — horizon on top, edges on sides
    if (comp.x < margin) { comp.x = margin; comp.vx = Math.abs(comp.vx); comp.direction = 2; }
    if (comp.x > this.width - fw - margin) { comp.x = this.width - fw - margin; comp.vx = -Math.abs(comp.vx); comp.direction = 1; }
    if (comp.y < horizonY) { comp.y = horizonY; comp.vy = Math.abs(comp.vy); comp.direction = 0; }
    if (comp.y > this.height - fh - margin) { comp.y = this.height - fh - margin; comp.vy = -Math.abs(comp.vy); comp.direction = 3; }
  }

  _updateSpirit(spirit, dt) {
    spirit.stateTimer -= dt;
    spirit.bobPhase += dt * 0.003; // gentle floating bob

    if (spirit.stateTimer <= 0) {
      const roll = Math.random();
      if (roll < 0.4) {
        // Idle near companion
        spirit.state = 'idle';
        spirit.vx = 0;
        spirit.vy = 0;
        spirit.stateTimer = 2000 + Math.random() * 3000;
      } else {
        // Wander around companion
        spirit.state = 'wander';
        spirit.wanderAngle = Math.random() * Math.PI * 2;
        const speed = 0.02 + Math.random() * 0.015;
        spirit.vx = Math.cos(spirit.wanderAngle) * speed;
        spirit.vy = Math.sin(spirit.wanderAngle) * speed;
        spirit.stateTimer = 1500 + Math.random() * 2500;
      }
    }

    // Move
    spirit.x += spirit.vx * dt;
    spirit.y += spirit.vy * dt;

    // Orbit pull — spirits stay near the companion
    if (this.companion) {
      const compCenterX = this.companion.x + (this.companion.data.frameSize[0] * this.companion.scale) / 2;
      const compCenterY = this.companion.y + (this.companion.data.frameSize[1] * this.companion.scale) / 2;
      const dx = spirit.x - compCenterX;
      const dy = spirit.y - compCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxOrbit = 300;
      const minOrbit = 80;

      if (dist > maxOrbit) {
        // Pull back toward companion (gentle)
        const pull = 0.00012;
        spirit.vx -= (dx / dist) * pull * dt;
        spirit.vy -= (dy / dist) * pull * dt;
      } else if (dist < minOrbit) {
        // Push away slightly
        spirit.vx += (dx / dist) * 0.0001 * dt;
        spirit.vy += (dy / dist) * 0.0001 * dt;
      }
    }

    // Clamp velocity to prevent teleporting
    const maxSpeed = 0.08;
    if (spirit.vx > maxSpeed) spirit.vx = maxSpeed;
    if (spirit.vx < -maxSpeed) spirit.vx = -maxSpeed;
    if (spirit.vy > maxSpeed) spirit.vy = maxSpeed;
    if (spirit.vy < -maxSpeed) spirit.vy = -maxSpeed;

    // Hard bounds
    const margin = 10;
    if (spirit.x < margin) { spirit.x = margin; spirit.vx = Math.abs(spirit.vx) * 0.5; }
    if (spirit.x > this.width - spirit.size - margin) { spirit.x = this.width - spirit.size - margin; spirit.vx = -Math.abs(spirit.vx) * 0.5; }
    if (spirit.y < margin) { spirit.y = margin; spirit.vy = Math.abs(spirit.vy) * 0.5; }
    if (spirit.y > this.height - spirit.size - margin) { spirit.y = this.height - spirit.size - margin; spirit.vy = -Math.abs(spirit.vy) * 0.5; }
  }

  // ── DRAW ────────────────────────────────────────────────────

  _drawCompanion(comp) {
    const animData = comp.images[comp.animation] || comp.images['idle'];
    if (!animData) return;

    const [fw, fh] = comp.data.frameSize;
    const cols = animData.cols || animData.frames;
    const row = comp.direction;
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

  _drawSpirit(spirit) {
    const bob = Math.sin(spirit.bobPhase) * 3; // gentle float
    const x = spirit.x;
    const y = spirit.y + bob;
    const s = spirit.size;

    // Soft glow
    this.ctx.save();
    this.ctx.globalAlpha = 0.15;
    this.ctx.fillStyle = '#00aaff';
    this.ctx.beginPath();
    this.ctx.ellipse(x + s / 2, y + s / 2, s * 0.7, s * 0.7, 0, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();

    // Shadow
    this.ctx.fillStyle = 'rgba(0,0,0,0.15)';
    this.ctx.beginPath();
    this.ctx.ellipse(x + s / 2, spirit.y + s + 2, s * 0.3, 3, 0, 0, Math.PI * 2);
    this.ctx.fill();

    // Cybermon image
    if (!spirit.img || !spirit.img.complete || spirit.img.naturalWidth === 0) return;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(spirit.img, x, y, s, s);

    // Name label — subtle
    this.ctx.fillStyle = 'rgba(200,220,255,0.6)';
    this.ctx.font = '9px Orbitron, monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(spirit.name, x + s / 2, spirit.y - 4);
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
    if (this.companion) this._updateCompanion(this.companion, dt);
    for (const spirit of this.spirits) this._updateSpirit(spirit, dt);
    this._updateToys(dt);

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
    for (const treat of this.treats) {
      const bounce = Math.sin(treat.bouncePhase) * 2;
      this.ctx.font = '31px serif';
      this.ctx.textAlign = 'center';
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
      const wobble = speed > 0.01 ? Math.sin(spin) * 3 : 0;
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

    // Collect all entities for Y-sort depth ordering
    const entities = [];
    if (this.companion) {
      entities.push({ type: 'companion', obj: this.companion, y: this.companion.y + (this.companion.data.frameSize[1] * this.companion.scale) });
    }
    for (const spirit of this.spirits) {
      entities.push({ type: 'spirit', obj: spirit, y: spirit.y + spirit.size });
    }
    entities.sort((a, b) => a.y - b.y);

    for (const ent of entities) {
      if (ent.type === 'companion') this._drawCompanion(ent.obj);
      else this._drawSpirit(ent.obj);
    }

    // Update speech bubble position
    if (this.bubbleEl) this._updateBubblePosition();

    this.animId = requestAnimationFrame(() => this._animate());
  }

  dispose() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.companion = null;
    this.spirits = [];
  }

  // ── GET ENTITY BOUNDS (for camera crop) ─────────────────────

  getEntityBounds(agentId) {
    if (this.companion && this.companion.id === agentId) {
      const c = this.companion;
      const dw = (c.data.frameSize[0] || 32) * c.scale;
      const dh = (c.data.frameSize[1] || 32) * c.scale;
      return { x: c.x, y: c.y, w: dw, h: dh };
    }
    const spirit = this.spirits.find(s => s.id === agentId);
    if (spirit) {
      return { x: spirit.x, y: spirit.y, w: spirit.size, h: spirit.size };
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
      spirits: this.spirits.map(s => ({
        id: s.id,
        name: s.name,
        spiritId: s.spiritId,
      })),
    };
  }
}

// Export globally
window.PixelArena = PixelArena;
try { _fs.appendFileSync(_path.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] PixelArena exported OK\n`); } catch {}
