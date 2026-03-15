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

    this._resize();
    this._generateGrass();
    this._initResize();
    this._initClick();
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
    const basePath = _path.join(__dirname, '..', 'assets', 'pixel-companions', compData.folder);
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
    const imgPath = _path.join(__dirname, '..', 'assets', 'spirits', `${spiritId}.png`);
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

  // ── UPDATE LOGIC ────────────────────────────────────────────

  _updateCompanion(comp, dt) {
    // Frame animation
    comp.frameTimer += dt;
    const animData = comp.images[comp.animation];
    if (animData && comp.frameTimer >= comp.frameSpeed) {
      comp.frameTimer = 0;
      comp.frame = (comp.frame + 1) % animData.frames;
    }

    // AI state machine — mostly idle, sometimes wander
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
        // Pull back toward companion
        spirit.vx -= (dx / dist) * 0.00015 * dt;
        spirit.vy -= (dy / dist) * 0.00015 * dt;
      } else if (dist < minOrbit) {
        // Push away slightly
        spirit.vx += (dx / dist) * 0.0001 * dt;
        spirit.vy += (dy / dist) * 0.0001 * dt;
      }
    }

    // Hard bounds
    const margin = 10;
    if (spirit.x < margin) { spirit.x = margin; spirit.vx = Math.abs(spirit.vx); }
    if (spirit.x > this.width - spirit.size - margin) { spirit.x = this.width - spirit.size - margin; spirit.vx = -Math.abs(spirit.vx); }
    if (spirit.y < margin) { spirit.y = margin; spirit.vy = Math.abs(spirit.vy); }
    if (spirit.y > this.height - spirit.size - margin) { spirit.y = this.height - spirit.size - margin; spirit.vy = -Math.abs(spirit.vy); }
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

    // Crown indicator
    this.ctx.font = '16px serif';
    this.ctx.fillText('👑', comp.x + dw / 2, comp.y - 26);
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
    const dt = now - this.lastTime;
    this.lastTime = now;

    // Update
    if (this.companion) this._updateCompanion(this.companion, dt);
    for (const spirit of this.spirits) this._updateSpirit(spirit, dt);

    // Draw
    this._drawGround();

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
